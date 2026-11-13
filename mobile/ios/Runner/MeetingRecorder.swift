import AVFoundation
import ActivityKit
import Flutter
import Foundation
import UIKit

enum MeetingRecorderError: Error {
    case busy
    case notRecording
}

/// Records a meeting note segment to an ADTS AAC file (16 kHz mono). ADTS has
/// no trailing index, so the file stays playable up to the last frame even if
/// the app is killed mid-recording.
final class MeetingRecorder: MicrophoneConsumer {
    static let shared = MeetingRecorder()
    private static let sampleRate: Double = 16000

    /// Called on the main thread when the recorder pauses or resumes by itself.
    var onStateChanged: (([String: Any]) -> Void)?

    private let microphone = MicrophoneEngine.shared
    private let lock = NSLock()
    private let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: MeetingRecorder.sampleRate,
        channels: 1,
        interleaved: false
    )!

    private var noteId: String?
    private var segmentId: String?
    private var file: AVAudioFile?
    private var converter: AVAudioConverter?
    private var framesWritten: AVAudioFramePosition = 0
    private var priorElapsedMs = 0
    private var isPaused = false
    private var isPausedByInterruption = false
    private var activityRef: Any?

    private init() {}

    // MARK: - Commands

    func start(noteId: String, segmentId: String, path: String, priorElapsedMs: Int) throws {
        guard self.noteId == nil else { throw MeetingRecorderError.busy }
        let url = URL(fileURLWithPath: path)
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: MeetingRecorder.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32000,
        ]
        let file = try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )

        lock.lock()
        self.noteId = noteId
        self.segmentId = segmentId
        self.file = file
        self.converter = nil
        self.framesWritten = 0
        self.priorElapsedMs = priorElapsedMs
        self.isPaused = false
        self.isPausedByInterruption = false
        lock.unlock()

        do {
            try microphone.attach(self)
        } catch {
            reset()
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        startLiveActivity(noteId: noteId)
    }

    func pause() -> [String: Any]? {
        lock.lock()
        guard noteId != nil else { lock.unlock(); return nil }
        isPaused = true
        isPausedByInterruption = false
        lock.unlock()
        microphone.detach(self)
        updateLiveActivity()
        return state()
    }

    func resume() throws -> [String: Any]? {
        lock.lock()
        guard noteId != nil else { lock.unlock(); throw MeetingRecorderError.notRecording }
        lock.unlock()
        try microphone.attach(self)
        lock.lock()
        isPaused = false
        isPausedByInterruption = false
        lock.unlock()
        updateLiveActivity()
        return state()
    }

    func stop() -> [String: Any]? {
        let final = state()
        microphone.detach(self)
        reset()
        endLiveActivities()
        return final
    }

    func state() -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        guard let noteId = noteId, let segmentId = segmentId else { return nil }
        return [
            "noteId": noteId,
            "segmentId": segmentId,
            "isPaused": isPaused,
            "segmentElapsedMs": segmentElapsedMsLocked(),
        ]
    }

    /// A recorder can only live as long as its process; activities left over
    /// from a killed process are stale.
    func cleanupOnLaunch() {
        endLiveActivities()
    }

    private func reset() {
        lock.lock()
        noteId = nil
        segmentId = nil
        file = nil
        converter = nil
        framesWritten = 0
        isPaused = false
        isPausedByInterruption = false
        lock.unlock()
    }

    private func segmentElapsedMsLocked() -> Int {
        Int(Double(framesWritten) * 1000 / MeetingRecorder.sampleRate)
    }

    // MARK: - MicrophoneConsumer

    func microphone(didReceive buffer: AVAudioPCMBuffer) {
        lock.lock()
        defer { lock.unlock() }
        guard !isPaused, let file = file, buffer.frameLength > 0 else { return }

        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: outputFormat)
            converter?.downmix = true
        }
        guard let converter = converter else { return }

        let ratio = MeetingRecorder.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return }

        var consumed = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if consumed {
                status.pointee = .noDataNow
                return nil
            }
            consumed = true
            status.pointee = .haveData
            return buffer
        }
        if let error = error {
            NSLog("[VoquillApp] Meeting audio conversion failed: %@", error.localizedDescription)
            return
        }
        guard output.frameLength > 0 else { return }
        do {
            try file.write(from: output)
            framesWritten += AVAudioFramePosition(output.frameLength)
        } catch {
            NSLog("[VoquillApp] Meeting audio write failed: %@", error.localizedDescription)
        }
    }

    func microphoneInterruptionBegan() {
        lock.lock()
        guard noteId != nil, !isPaused else { lock.unlock(); return }
        isPaused = true
        isPausedByInterruption = true
        lock.unlock()
        notifyStateChanged()
    }

    func microphoneInterruptionEnded(resumed: Bool) {
        lock.lock()
        guard noteId != nil, isPausedByInterruption else { lock.unlock(); return }
        isPausedByInterruption = false
        isPaused = !resumed
        lock.unlock()
        if !resumed { microphone.detach(self) }
        notifyStateChanged()
    }

    private func notifyStateChanged() {
        DispatchQueue.main.async {
            self.updateLiveActivity()
            if let state = self.state() { self.onStateChanged?(state) }
        }
    }

    // MARK: - Live Activity

    private func contentState() -> Any? {
        guard #available(iOS 16.2, *) else { return nil }
        lock.lock()
        let elapsedMs = priorElapsedMs + segmentElapsedMsLocked()
        let paused = isPaused
        lock.unlock()
        return MeetingNoteAttributes.ContentState(
            isPaused: paused,
            elapsedSeconds: elapsedMs / 1000,
            timerStart: Date().addingTimeInterval(-Double(elapsedMs) / 1000)
        )
    }

    private func startLiveActivity(noteId: String) {
        guard #available(iOS 16.2, *) else { return }
        endLiveActivities()
        guard ActivityAuthorizationInfo().areActivitiesEnabled,
              let state = contentState() as? MeetingNoteAttributes.ContentState else { return }
        do {
            activityRef = try Activity.request(
                attributes: MeetingNoteAttributes(noteId: noteId),
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
        } catch {
            NSLog("[VoquillApp] Failed to start meeting Live Activity: %@", error.localizedDescription)
        }
    }

    private func updateLiveActivity() {
        guard #available(iOS 16.2, *),
              let activity = activityRef as? Activity<MeetingNoteAttributes>,
              let state = contentState() as? MeetingNoteAttributes.ContentState else { return }
        Task { await activity.update(.init(state: state, staleDate: nil)) }
    }

    private func endLiveActivities() {
        activityRef = nil
        guard #available(iOS 16.2, *) else { return }
        Task {
            for activity in Activity<MeetingNoteAttributes>.activities {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
    }
}

/// `com.voquill.mobile/note_recorder`: the Dart `NoteRecorder` bridge.
final class NoteRecorderChannel {
    private let channel: FlutterMethodChannel
    private var pendingAction: [String: String]?
    private var backgroundTask: UIBackgroundTaskIdentifier = .invalid

    init(binaryMessenger: FlutterBinaryMessenger) {
        channel = FlutterMethodChannel(name: "com.voquill.mobile/note_recorder", binaryMessenger: binaryMessenger)
        channel.setMethodCallHandler { [weak self] call, result in
            self?.handle(call, result: result)
        }
        MeetingRecorder.shared.onStateChanged = { [weak self] state in
            self?.channel.invokeMethod("onStateChanged", arguments: state)
        }
    }

    /// Delivers a Live Activity tap, or keeps it until Dart asks for it.
    func deliver(action: String, noteId: String) {
        let payload = ["action": action, "noteId": noteId]
        channel.invokeMethod("onAction", arguments: payload) { [weak self] response in
            if response is FlutterError || (response as? NSObject) === FlutterMethodNotImplemented {
                self?.pendingAction = payload
            }
        }
    }

    private func handle(_ call: FlutterMethodCall, result: @escaping FlutterResult) {
        let recorder = MeetingRecorder.shared
        switch call.method {
        case "start":
            guard let args = call.arguments as? [String: Any],
                  let noteId = args["noteId"] as? String,
                  let segmentId = args["segmentId"] as? String,
                  let path = args["path"] as? String else {
                result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
                return
            }
            let prior = (args["priorElapsedMs"] as? NSNumber)?.intValue ?? 0
            do {
                try recorder.start(noteId: noteId, segmentId: segmentId, path: path, priorElapsedMs: prior)
                result(nil)
            } catch {
                result(FlutterError(code: "START_FAILED", message: error.localizedDescription, details: nil))
            }
        case "pause":
            result(recorder.pause())
        case "resume":
            do {
                result(try recorder.resume())
            } catch {
                result(FlutterError(code: "RESUME_FAILED", message: error.localizedDescription, details: nil))
            }
        case "stop":
            result(recorder.stop())
        case "getState":
            result(recorder.state())
        case "takePendingAction":
            result(pendingAction)
            pendingAction = nil
        case "setSyncActive":
            let isActive = (call.arguments as? [String: Any])?["isActive"] as? Bool ?? false
            setBackgroundTask(active: isActive)
            result(nil)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    /// Asks iOS for extra time so an upload started in the foreground can
    /// finish after the user leaves the app.
    private func setBackgroundTask(active: Bool) {
        if active, backgroundTask == .invalid {
            backgroundTask = UIApplication.shared.beginBackgroundTask(withName: "NotesSync") { [weak self] in
                self?.setBackgroundTask(active: false)
            }
        } else if !active, backgroundTask != .invalid {
            UIApplication.shared.endBackgroundTask(backgroundTask)
            backgroundTask = .invalid
        }
    }
}
