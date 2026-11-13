import AVFoundation
import ActivityKit
import Foundation

class DictationService: MicrophoneConsumer {
    static let shared = DictationService()

    private let microphone = MicrophoneEngine.shared
    private var audioFile: AVAudioFile?
    private var isRecording = false
    private var activityRef: Any?

    @available(iOS 16.2, *)
    private var activity: Activity<DictationAttributes>? {
        get { activityRef as? Activity<DictationAttributes> }
        set { activityRef = newValue }
    }

    private let defaults = UserDefaults(suiteName: DictationConstants.appGroupId)
    private var heartbeatTimer: Timer?
    private var recordingTimeoutTimer: Timer?
    private var idleTimeoutTimer: Timer?

    private init() {}

    var currentPhase: DictationPhase {
        let raw = defaults?.string(forKey: DictationConstants.phaseKey) ?? "idle"
        return DictationPhase(rawValue: raw) ?? .idle
    }

    func startDictation() {
        guard currentPhase == .idle else {
            NSLog("[VoquillApp] startDictation ignored, phase is %@", currentPhase.rawValue)
            return
        }
        NSLog("[VoquillApp] startDictation")

        let now = Date().timeIntervalSince1970
        defaults?.set(now, forKey: DictationConstants.startedAtKey)

        do {
            try microphone.attach(self)
        } catch {
            NSLog("[VoquillApp] Audio setup failed: %@", error.localizedDescription)
            stopDictation()
            return
        }

        createNewAudioFile()
        isRecording = true

        startLiveActivity()
        startHeartbeat()
        setPhase(.recording)
        startRecordingTimeout()

        DarwinNotificationManager.shared.observe(DictationConstants.stopRecording) { [weak self] in
            self?.pauseRecording()
        }
        DarwinNotificationManager.shared.observe(DictationConstants.startRecording) { [weak self] in
            self?.resumeRecording()
        }
        DarwinNotificationManager.shared.observe(DictationConstants.stopDictation) { [weak self] in
            self?.stopDictation()
        }
    }

    func pauseRecording() {
        guard currentPhase == .recording else { return }
        NSLog("[VoquillApp] pauseRecording")
        stopRecordingTimeout()
        isRecording = false
        audioFile = nil
        defaults?.set(Float(0), forKey: DictationConstants.audioLevelKey)
        setPhase(.active)
        updateLiveActivity(phase: "active")
        startIdleTimeout()
    }

    func resumeRecording() {
        guard currentPhase == .active else { return }
        NSLog("[VoquillApp] resumeRecording")
        stopIdleTimeout()

        if !microphone.isRunning || !microphone.isAttached(self) {
            NSLog("[VoquillApp] Microphone not running, attempting restart")
            do {
                try microphone.attach(self)
            } catch {
                NSLog("[VoquillApp] Failed to restart microphone: %@", error.localizedDescription)
                stopDictation()
                return
            }
        }

        createNewAudioFile()
        isRecording = true
        setPhase(.recording)
        updateLiveActivity(phase: "recording")
        startRecordingTimeout()
    }

    func stopDictation() {
        NSLog("[VoquillApp] stopDictation")
        DarwinNotificationManager.shared.removeObserver(DictationConstants.stopRecording)
        DarwinNotificationManager.shared.removeObserver(DictationConstants.startRecording)
        DarwinNotificationManager.shared.removeObserver(DictationConstants.stopDictation)

        stopRecordingTimeout()
        stopIdleTimeout()
        isRecording = false
        audioFile = nil
        defaults?.set(Float(0), forKey: DictationConstants.audioLevelKey)
        microphone.detach(self)
        stopHeartbeat()
        setPhase(.idle)

        endLiveActivity()
        endAllLiveActivities()
    }

    func microphone(didReceive buffer: AVAudioPCMBuffer) {
        guard isRecording else { return }
        try? audioFile?.write(from: buffer)
        updateAudioLevel(buffer: buffer)
    }

    private func createNewAudioFile() {
        guard let format = microphone.inputFormat,
              let audioUrl = DictationConstants.audioFileURL else { return }
        try? FileManager.default.removeItem(at: audioUrl)

        let settings: [String: Any] = [
            AVFormatIDKey: Int(kAudioFormatMPEG4AAC),
            AVSampleRateKey: format.sampleRate,
            AVNumberOfChannelsKey: 1,
            AVEncoderAudioQualityKey: AVAudioQuality.medium.rawValue
        ]
        audioFile = try? AVAudioFile(forWriting: audioUrl, settings: settings)
    }

    private func updateAudioLevel(buffer: AVAudioPCMBuffer) {
        guard let data = buffer.floatChannelData?[0] else { return }
        let count = Int(buffer.frameLength)
        guard count > 0 else { return }

        var sum: Float = 0
        for i in 0..<count {
            sum += data[i] * data[i]
        }
        let rms = sqrt(sum / Float(count))
        let db = 20 * log10(max(rms, 1e-6))
        let normalized = max(0, min(1, (db + 50) / 50))

        defaults?.set(normalized, forKey: DictationConstants.audioLevelKey)
    }

    private func startRecordingTimeout() {
        stopRecordingTimeout()
        recordingTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: DictationConstants.maxRecordingDuration,
            repeats: false
        ) { [weak self] _ in
            guard let self = self, self.currentPhase == .recording else { return }
            NSLog("[VoquillApp] Recording timeout reached")
            self.pauseRecording()
        }
    }

    private func stopRecordingTimeout() {
        recordingTimeoutTimer?.invalidate()
        recordingTimeoutTimer = nil
    }

    // MARK: - Idle Timeout

    private func startIdleTimeout() {
        stopIdleTimeout()
        let timeout = defaults?.double(forKey: DictationConstants.idleTimeoutKey) ?? 0

        // 0 with key present means "keep running" — skip timer
        if defaults?.object(forKey: DictationConstants.idleTimeoutKey) != nil && timeout == 0 {
            NSLog("[VoquillApp] Idle timeout disabled (keep running mode)")
            return
        }

        let duration = timeout > 0 ? timeout : DictationConstants.defaultIdleTimeout
        NSLog("[VoquillApp] Starting idle timeout: %.0f seconds", duration)
        idleTimeoutTimer = Timer.scheduledTimer(
            withTimeInterval: duration,
            repeats: false
        ) { [weak self] _ in
            guard let self = self, self.currentPhase == .active else { return }
            NSLog("[VoquillApp] Idle timeout reached, stopping dictation")
            self.stopDictation()
        }
    }

    private func stopIdleTimeout() {
        idleTimeoutTimer?.invalidate()
        idleTimeoutTimer = nil
    }

    /// Restart idle timer with current settings if in `.active` phase.
    /// Called when timeout setting changes via Flutter so the new value takes effect immediately.
    func restartIdleTimeoutIfActive() {
        guard currentPhase == .active else { return }
        startIdleTimeout()
    }

    // MARK: - Heartbeat

    private func startHeartbeat() {
        stopHeartbeat()
        writeHeartbeat()
        heartbeatTimer = Timer.scheduledTimer(withTimeInterval: 2.0, repeats: true) { [weak self] _ in
            self?.writeHeartbeat()
        }
    }

    private func stopHeartbeat() {
        heartbeatTimer?.invalidate()
        heartbeatTimer = nil
        defaults?.removeObject(forKey: DictationConstants.heartbeatKey)
    }

    private func writeHeartbeat() {
        defaults?.set(Date().timeIntervalSince1970, forKey: DictationConstants.heartbeatKey)
    }

    // MARK: - Microphone Interruption

    func microphoneInterruptionBegan() {
        NSLog("[VoquillApp] Dictation interrupted (e.g. phone call)")
        stopRecordingTimeout()
        stopIdleTimeout()
        isRecording = false
        audioFile = nil
        defaults?.set(Float(0), forKey: DictationConstants.audioLevelKey)
    }

    func microphoneInterruptionEnded(resumed: Bool) {
        guard resumed else {
            NSLog("[VoquillApp] Dictation interruption ended, not resumable — stopping")
            stopDictation()
            return
        }
        guard currentPhase == .recording || currentPhase == .active else { return }
        NSLog("[VoquillApp] Dictation interruption ended, resuming")
        createNewAudioFile()
        isRecording = true
        setPhase(.recording)
        updateLiveActivity(phase: "recording")
        startRecordingTimeout()
    }

    // MARK: - Live Activity

    private func startLiveActivity() {
        guard #available(iOS 16.2, *) else { return }
        guard ActivityAuthorizationInfo().areActivitiesEnabled else {
            NSLog("[VoquillApp] Live Activities not enabled")
            return
        }

        let attributes = DictationAttributes()
        let state = DictationAttributes.ContentState(phase: "recording", elapsedSeconds: 0)

        do {
            activity = try Activity.request(
                attributes: attributes,
                content: .init(state: state, staleDate: nil),
                pushType: nil
            )
            NSLog("[VoquillApp] Live Activity started")
        } catch {
            NSLog("[VoquillApp] Failed to start Live Activity: %@", error.localizedDescription)
        }
    }

    private func updateLiveActivity(phase: String) {
        guard #available(iOS 16.2, *) else { return }
        let state = DictationAttributes.ContentState(phase: phase, elapsedSeconds: 0)
        Task {
            await activity?.update(.init(state: state, staleDate: nil))
        }
    }

    private func endLiveActivity() {
        guard #available(iOS 16.2, *) else { return }
        let state = DictationAttributes.ContentState(phase: "idle", elapsedSeconds: 0)
        Task {
            await activity?.end(.init(state: state, staleDate: nil), dismissalPolicy: .immediate)
            activity = nil
        }
    }

    private func endAllLiveActivities() {
        guard #available(iOS 16.2, *) else { return }
        let state = DictationAttributes.ContentState(phase: "idle", elapsedSeconds: 0)
        Task {
            for activity in Activity<DictationAttributes>.activities {
                await activity.end(.init(state: state, staleDate: nil), dismissalPolicy: .immediate)
            }
        }
    }

    func cleanupOnLaunch() {
        setPhase(.idle)
        stopHeartbeat()
        endAllLiveActivities()
    }

    // MARK: - Phase Management

    private func setPhase(_ phase: DictationPhase) {
        defaults?.set(phase.rawValue, forKey: DictationConstants.phaseKey)
        DarwinNotificationManager.shared.post(DictationConstants.dictationPhaseChanged)
    }
}
