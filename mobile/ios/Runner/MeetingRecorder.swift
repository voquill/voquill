import AVFoundation
import ActivityKit
import Flutter
import Foundation
import UIKit

enum MeetingRecorderError: LocalizedError {
    case busy
    case notRecording
    case lowStorage

    var errorDescription: String? {
        switch self {
        case .busy: return "A meeting is already recording"
        case .notRecording: return "No meeting is recording"
        case .lowStorage: return "Not enough free storage to record"
        }
    }
}

/// Records a meeting note as ADTS AAC segments (16 kHz mono). ADTS has no
/// trailing index, so a file stays playable up to its last frame even if the
/// app is killed mid-recording.
///
/// Segments roll over to a new file (same directory, new UUID) at
/// `maxSegmentMs` or `maxSegmentBytes`, between two buffers, so no audio is
/// lost at the boundary.
/// At `maxNoteMs` recording pauses with reason `limit`. A failed write ends
/// the session with reason `write_failed`; what was written stays on disk.
final class MeetingRecorder: MicrophoneConsumer {
    static let shared = MeetingRecorder()
    static let sampleRate: Double = 16000
    /// Refuse to start below this much free space.
    static let minimumFreeBytes: Int64 = 20 * 1024 * 1024

    /// Called on the main thread when the recorder changes state by itself.
    var onStateChanged: (([String: Any]) -> Void)?

    private struct Session {
        let noteId: String
        var segmentId: String
        let directory: URL
        var file: AVAudioFile
        let converter: PCMConverter
        var fileUrl: URL
        var segmentFrames: AVAudioFramePosition = 0
        var sessionFrames: AVAudioFramePosition = 0
        var buffersSinceSizeCheck = 0
        var silentFrames: AVAudioFramePosition = 0
        var isSilent = false
        let priorElapsedMs: Int
        let maxSegmentMs: Int
        let maxSegmentBytes: Int64
        let maxNoteMs: Int
        var isPaused = false
        var isPausedByInterruption = false
    }

    private let microphone = MicrophoneEngine.shared
    private let lock = NSLock()
    private var session: Session?
    private var activityRef: Any?
    private var staleTimer: Timer?

    private static let outputFormat = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: sampleRate,
        channels: 1,
        interleaved: false
    )!

    private init() {}

    private static func openFile(at url: URL) throws -> AVAudioFile {
        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderBitRateKey: 32000,
        ]
        return try AVAudioFile(
            forWriting: url,
            settings: settings,
            commonFormat: .pcmFormatFloat32,
            interleaved: false
        )
    }

    static func freeBytes(at url: URL) -> Int64 {
        let values = try? url.resourceValues(forKeys: [.volumeAvailableCapacityForImportantUsageKey])
        return values?.volumeAvailableCapacityForImportantUsage ?? Int64.max
    }

    // MARK: - Commands

    func start(
        noteId: String,
        segmentId: String,
        path: String,
        priorElapsedMs: Int,
        maxSegmentMs: Int,
        maxSegmentBytes: Int64,
        maxNoteMs: Int
    ) throws {
        lock.lock()
        let isBusy = session != nil
        lock.unlock()
        guard !isBusy else { throw MeetingRecorderError.busy }

        let url = URL(fileURLWithPath: path)
        let directory = url.deletingLastPathComponent()
        guard MeetingRecorder.freeBytes(at: directory) >= MeetingRecorder.minimumFreeBytes else {
            throw MeetingRecorderError.lowStorage
        }
        let file = try MeetingRecorder.openFile(at: url)

        lock.lock()
        session = Session(
            noteId: noteId,
            segmentId: segmentId,
            directory: directory,
            file: file,
            converter: PCMConverter(outputFormat: MeetingRecorder.outputFormat),
            fileUrl: url,
            priorElapsedMs: priorElapsedMs,
            maxSegmentMs: maxSegmentMs,
            maxSegmentBytes: maxSegmentBytes,
            maxNoteMs: maxNoteMs
        )
        lock.unlock()

        do {
            try microphone.attach(self)
        } catch {
            lock.lock()
            session = nil
            lock.unlock()
            try? FileManager.default.removeItem(at: url)
            throw error
        }
        startLiveActivity(noteId: noteId)
    }

    func pause() -> [String: Any]? {
        lock.lock()
        guard session != nil else { lock.unlock(); return nil }
        session?.isPaused = true
        session?.isPausedByInterruption = false
        session?.silentFrames = 0
        session?.isSilent = false
        lock.unlock()
        microphone.detach(self)
        updateLiveActivity()
        return state()
    }

    func resume() throws -> [String: Any]? {
        lock.lock()
        guard let current = session else { lock.unlock(); throw MeetingRecorderError.notRecording }
        lock.unlock()
        guard MeetingRecorder.freeBytes(at: current.directory) >= MeetingRecorder.minimumFreeBytes else {
            throw MeetingRecorderError.lowStorage
        }
        try microphone.attach(self)
        lock.lock()
        session?.isPaused = false
        session?.isPausedByInterruption = false
        lock.unlock()
        updateLiveActivity()
        return state()
    }

    func stop() -> [String: Any]? {
        let final = state()
        microphone.detach(self)
        lock.lock()
        session = nil
        lock.unlock()
        endLiveActivities()
        return final
    }

    func state(reason: String? = nil) -> [String: Any]? {
        lock.lock()
        defer { lock.unlock() }
        guard let session = session else { return nil }
        return MeetingRecorder.stateMap(session, reason: reason)
    }

    private static func stateMap(_ session: Session, reason: String?) -> [String: Any] {
        var map: [String: Any] = [
            "noteId": session.noteId,
            "segmentId": session.segmentId,
            "isPaused": session.isPaused,
            "segmentElapsedMs": milliseconds(session.segmentFrames),
            "isSilent": session.isSilent,
        ]
        if let reason = reason { map["reason"] = reason }
        return map
    }

    /// Peak under -78 dBFS for 20 s means the OS is feeding silence (a call,
    /// another app holding the mic); returns true when that state changes.
    private static func trackSilence(_ session: inout Session, _ buffer: AVAudioPCMBuffer) -> Bool {
        guard let samples = buffer.floatChannelData?[0] else { return false }
        var peak: Float = 0
        for i in 0..<Int(buffer.frameLength) {
            peak = max(peak, abs(samples[i]))
        }
        session.silentFrames = peak < 0.000125 ? session.silentFrames + AVAudioFramePosition(buffer.frameLength) : 0
        let isSilent = milliseconds(session.silentFrames) >= 20_000
        guard isSilent != session.isSilent else { return false }
        session.isSilent = isSilent
        return true
    }

    /// Checks the file size every ~100 buffers (about 8 s of audio); the
    /// byte cap is set far enough below the server's that this is precise
    /// enough.
    private static func isOverSize(_ session: inout Session) -> Bool {
        session.buffersSinceSizeCheck += 1
        guard session.buffersSinceSizeCheck >= 100 else { return false }
        session.buffersSinceSizeCheck = 0
        let size = (try? session.fileUrl.resourceValues(forKeys: [.fileSizeKey]).fileSize) ?? 0
        return Int64(size) >= session.maxSegmentBytes
    }

    private static func milliseconds(_ frames: AVAudioFramePosition) -> Int {
        Int(Double(frames) * 1000 / sampleRate)
    }

    /// A recorder only lives as long as its process; activities left over
    /// from a killed process are stale.
    func cleanupOnLaunch() {
        endLiveActivities()
    }

    // MARK: - MicrophoneConsumer

    func microphone(didReceive buffer: AVAudioPCMBuffer) {
        var event: [String: Any]?
        var endSession = false

        lock.lock()
        if var current = session, !current.isPaused, let output = current.converter.convert(buffer) {
            do {
                try current.file.write(from: output)
                let frames = AVAudioFramePosition(output.frameLength)
                current.segmentFrames += frames
                current.sessionFrames += frames
                let silenceChanged = MeetingRecorder.trackSilence(&current, output)

                if current.priorElapsedMs + MeetingRecorder.milliseconds(current.sessionFrames) >= current.maxNoteMs {
                    current.isPaused = true
                    event = MeetingRecorder.stateMap(current, reason: "limit")
                } else if MeetingRecorder.milliseconds(current.segmentFrames) >= current.maxSegmentMs
                            || MeetingRecorder.isOverSize(&current) {
                    let nextId = UUID().uuidString.lowercased()
                    let nextUrl = current.directory.appendingPathComponent("\(nextId).aac")
                    current.file = try MeetingRecorder.openFile(at: nextUrl)
                    current.fileUrl = nextUrl
                    current.segmentId = nextId
                    current.segmentFrames = 0
                    current.buffersSinceSizeCheck = 0
                    event = MeetingRecorder.stateMap(current, reason: "rollover")
                } else if silenceChanged {
                    event = MeetingRecorder.stateMap(current, reason: "silence")
                }
                session = current
            } catch {
                NSLog("[VoquillApp] Meeting audio write failed: %@", error.localizedDescription)
                current.isPaused = true
                event = MeetingRecorder.stateMap(current, reason: "write_failed")
                session = nil
                endSession = true
            }
        }
        lock.unlock()

        guard let event = event else { return }
        DispatchQueue.main.async {
            if endSession || event["reason"] as? String == "limit" {
                self.microphone.detach(self)
            }
            if endSession { self.endLiveActivities() } else { self.updateLiveActivity() }
            self.onStateChanged?(event)
        }
    }

    func microphoneInterruptionBegan() {
        lock.lock()
        guard session != nil, session?.isPaused == false else { lock.unlock(); return }
        session?.isPaused = true
        session?.isPausedByInterruption = true
        lock.unlock()
        notifyStateChanged(reason: "interruption")
    }

    func microphoneInterruptionEnded(resumed: Bool) {
        lock.lock()
        guard session?.isPausedByInterruption == true else { lock.unlock(); return }
        session?.isPausedByInterruption = false
        session?.isPaused = !resumed
        lock.unlock()
        if !resumed { microphone.detach(self) }
        notifyStateChanged(reason: "interruption")
    }

    private func notifyStateChanged(reason: String) {
        DispatchQueue.main.async {
            self.updateLiveActivity()
            if let state = self.state(reason: reason) { self.onStateChanged?(state) }
        }
    }

    // MARK: - Live Activity

    /// Stale after this long without a refresh, so an activity orphaned by a
    /// crash stops claiming that notes are being taken.
    private static let activityStaleAfter: TimeInterval = 15 * 60
    private static let activityRefreshEvery: TimeInterval = 5 * 60

    private func contentState() -> Any? {
        guard #available(iOS 16.2, *) else { return nil }
        lock.lock()
        defer { lock.unlock() }
        guard let session = session else { return nil }
        let elapsedMs = session.priorElapsedMs + MeetingRecorder.milliseconds(session.sessionFrames)
        return MeetingNoteAttributes.ContentState(
            isPaused: session.isPaused,
            elapsedSeconds: elapsedMs / 1000,
            timerStart: Date().addingTimeInterval(-Double(elapsedMs) / 1000)
        )
    }

    private func startLiveActivity(noteId: String) {
        guard #available(iOS 16.2, *) else { return }
        // Snapshot the old activities before requesting the new one, so ending
        // them can never end the activity created here.
        let previous = Activity<MeetingNoteAttributes>.activities
        Task {
            for activity in previous {
                await activity.end(nil, dismissalPolicy: .immediate)
            }
        }
        guard ActivityAuthorizationInfo().areActivitiesEnabled,
              let state = contentState() as? MeetingNoteAttributes.ContentState else { return }
        do {
            activityRef = try Activity.request(
                attributes: MeetingNoteAttributes(noteId: noteId),
                content: .init(state: state, staleDate: Date().addingTimeInterval(MeetingRecorder.activityStaleAfter)),
                pushType: nil
            )
            startStaleTimer()
        } catch {
            NSLog("[VoquillApp] Failed to start meeting Live Activity: %@", error.localizedDescription)
        }
    }

    private func updateLiveActivity() {
        guard #available(iOS 16.2, *),
              let activity = activityRef as? Activity<MeetingNoteAttributes>,
              let state = contentState() as? MeetingNoteAttributes.ContentState else { return }
        let staleDate = Date().addingTimeInterval(MeetingRecorder.activityStaleAfter)
        Task { await activity.update(.init(state: state, staleDate: staleDate)) }
    }

    private func startStaleTimer() {
        staleTimer?.invalidate()
        staleTimer = Timer.scheduledTimer(withTimeInterval: MeetingRecorder.activityRefreshEvery, repeats: true) { [weak self] _ in
            self?.updateLiveActivity()
        }
    }

    private func endLiveActivities() {
        staleTimer?.invalidate()
        staleTimer = nil
        activityRef = nil
        guard #available(iOS 16.2, *) else { return }
        let activities = Activity<MeetingNoteAttributes>.activities
        Task {
            for activity in activities {
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
        let args = call.arguments as? [String: Any]
        switch call.method {
        case "start":
            guard let noteId = args?["noteId"] as? String,
                  let segmentId = args?["segmentId"] as? String,
                  let path = args?["path"] as? String,
                  let maxSegmentMs = (args?["maxSegmentMs"] as? NSNumber)?.intValue,
                  let maxSegmentBytes = (args?["maxSegmentBytes"] as? NSNumber)?.int64Value,
                  let maxNoteMs = (args?["maxNoteMs"] as? NSNumber)?.intValue else {
                result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
                return
            }
            do {
                try recorder.start(
                    noteId: noteId,
                    segmentId: segmentId,
                    path: path,
                    priorElapsedMs: (args?["priorElapsedMs"] as? NSNumber)?.intValue ?? 0,
                    maxSegmentMs: maxSegmentMs,
                    maxSegmentBytes: maxSegmentBytes,
                    maxNoteMs: maxNoteMs
                )
                result(nil)
            } catch {
                result(flutterError(error, code: "START_FAILED"))
            }
        case "pause":
            result(recorder.pause())
        case "resume":
            do {
                result(try recorder.resume())
            } catch {
                result(flutterError(error, code: "RESUME_FAILED"))
            }
        case "stop":
            result(recorder.stop())
        case "getState":
            result(recorder.state())
        case "freeBytes":
            guard let path = args?["path"] as? String else {
                result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
                return
            }
            result(NSNumber(value: MeetingRecorder.freeBytes(at: URL(fileURLWithPath: path))))
        case "excludeFromBackup":
            guard let path = args?["path"] as? String else {
                result(FlutterError(code: "INVALID_ARGS", message: nil, details: nil))
                return
            }
            var url = URL(fileURLWithPath: path, isDirectory: true)
            var values = URLResourceValues()
            values.isExcludedFromBackup = true
            do {
                try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
                try url.setResourceValues(values)
                result(nil)
            } catch {
                result(FlutterError(code: "BACKUP_EXCLUSION_FAILED", message: error.localizedDescription, details: nil))
            }
        case "canShareMicrophone":
            result(true)
        case "takePendingAction":
            result(pendingAction)
            pendingAction = nil
        case "setSyncActive":
            setBackgroundTask(active: args?["isActive"] as? Bool ?? false)
            result(nil)
        default:
            result(FlutterMethodNotImplemented)
        }
    }

    private func flutterError(_ error: Error, code: String) -> FlutterError {
        let isLowStorage = (error as? MeetingRecorderError) == .lowStorage
        return FlutterError(code: isLowStorage ? "LOW_STORAGE" : code, message: error.localizedDescription, details: nil)
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
