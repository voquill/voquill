import AVFoundation
import Foundation

protocol MicrophoneConsumer: AnyObject {
    /// Called on the audio tap thread.
    func microphone(didReceive buffer: AVAudioPCMBuffer)
    func microphoneInterruptionBegan()
    /// `resumed` is true when the engine is capturing again.
    func microphoneInterruptionEnded(resumed: Bool)
}

/// The app's single microphone capture. Dictation and meeting notes attach as
/// consumers of one input tap, so a meeting keeps recording while the user
/// dictates and both share one audio session.
final class MicrophoneEngine {
    static let shared = MicrophoneEngine()

    private struct WeakConsumer {
        weak var value: MicrophoneConsumer?
    }

    private var engine: AVAudioEngine?
    private var consumers: [ObjectIdentifier: WeakConsumer] = [:]
    private let lock = NSLock()
    private var isObserving = false

    private init() {}

    var isRunning: Bool { engine?.isRunning == true }

    var inputFormat: AVAudioFormat? { engine?.inputNode.outputFormat(forBus: 0) }

    func attach(_ consumer: MicrophoneConsumer) throws {
        lock.lock()
        consumers[ObjectIdentifier(consumer)] = WeakConsumer(value: consumer)
        lock.unlock()
        if isRunning { return }
        do {
            try configureSession()
            try startEngine()
            startObserving()
        } catch {
            detach(consumer)
            throw error
        }
    }

    func detach(_ consumer: MicrophoneConsumer) {
        lock.lock()
        consumers.removeValue(forKey: ObjectIdentifier(consumer))
        let isEmpty = liveConsumers().isEmpty
        lock.unlock()
        if isEmpty { stopEngine() }
    }

    func isAttached(_ consumer: MicrophoneConsumer) -> Bool {
        lock.lock()
        defer { lock.unlock() }
        return consumers[ObjectIdentifier(consumer)]?.value != nil
    }

    /// Must be called with `lock` held.
    private func liveConsumers() -> [MicrophoneConsumer] {
        consumers = consumers.filter { $0.value.value != nil }
        return consumers.values.compactMap { $0.value }
    }

    private func snapshot() -> [MicrophoneConsumer] {
        lock.lock()
        defer { lock.unlock() }
        return liveConsumers()
    }

    private func configureSession() throws {
        let session = AVAudioSession.sharedInstance()
        try session.setCategory(
            .playAndRecord,
            mode: .default,
            options: [.mixWithOthers, .defaultToSpeaker, .allowBluetoothA2DP]
        )
        try session.setAllowHapticsAndSystemSoundsDuringRecording(true)
        try session.setActive(true)
    }

    private func startEngine() throws {
        let engine = self.engine ?? AVAudioEngine()
        installTap(on: engine)
        engine.prepare()
        try engine.start()
        self.engine = engine
    }

    private func installTap(on engine: AVAudioEngine) {
        let input = engine.inputNode
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: 4096, format: input.outputFormat(forBus: 0)) { [weak self] buffer, _ in
            guard let self = self else { return }
            for consumer in self.snapshot() {
                consumer.microphone(didReceive: buffer)
            }
        }
    }

    private func stopEngine() {
        engine?.inputNode.removeTap(onBus: 0)
        engine?.stop()
        engine = nil
        stopObserving()
        try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
    }

    /// Restarts capture after an interruption or route change; false when iOS
    /// refuses (e.g. starting the mic from the background is not allowed).
    private func restart() -> Bool {
        do {
            try AVAudioSession.sharedInstance().setActive(true)
            if let engine = engine {
                engine.stop()
                installTap(on: engine)
                engine.prepare()
                try engine.start()
            } else {
                try startEngine()
            }
            return true
        } catch {
            NSLog("[VoquillApp] Microphone restart failed: %@", error.localizedDescription)
            return false
        }
    }

    // MARK: - Notifications

    private func startObserving() {
        guard !isObserving else { return }
        isObserving = true
        let center = NotificationCenter.default
        center.addObserver(self, selector: #selector(handleInterruption(_:)),
                           name: AVAudioSession.interruptionNotification,
                           object: AVAudioSession.sharedInstance())
        center.addObserver(self, selector: #selector(handleMediaServicesReset(_:)),
                           name: AVAudioSession.mediaServicesWereResetNotification,
                           object: AVAudioSession.sharedInstance())
        center.addObserver(self, selector: #selector(handleConfigurationChange(_:)),
                           name: .AVAudioEngineConfigurationChange,
                           object: nil)
    }

    private func stopObserving() {
        guard isObserving else { return }
        isObserving = false
        NotificationCenter.default.removeObserver(self)
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard let info = notification.userInfo,
              let rawType = info[AVAudioSessionInterruptionTypeKey] as? UInt,
              let type = AVAudioSession.InterruptionType(rawValue: rawType) else { return }

        switch type {
        case .began:
            NSLog("[VoquillApp] Microphone interrupted")
            snapshot().forEach { $0.microphoneInterruptionBegan() }
        case .ended:
            let rawOptions = info[AVAudioSessionInterruptionOptionKey] as? UInt ?? 0
            let shouldResume = AVAudioSession.InterruptionOptions(rawValue: rawOptions).contains(.shouldResume)
            let resumed = shouldResume && restart()
            NSLog("[VoquillApp] Microphone interruption ended, resumed=%d", resumed)
            snapshot().forEach { $0.microphoneInterruptionEnded(resumed: resumed) }
            if snapshot().isEmpty { stopEngine() }
        @unknown default:
            break
        }
    }

    /// AirPods connecting/disconnecting can change the input format and stop
    /// the engine; reinstall the tap with the new format and keep going.
    @objc private func handleConfigurationChange(_ notification: Notification) {
        guard let engine = engine, (notification.object as? AVAudioEngine) === engine else { return }
        NSLog("[VoquillApp] Audio engine configuration changed")
        DispatchQueue.main.async {
            guard self.engine != nil, !self.snapshot().isEmpty else { return }
            if !self.restart() {
                self.snapshot().forEach {
                    $0.microphoneInterruptionBegan()
                    $0.microphoneInterruptionEnded(resumed: false)
                }
            }
        }
    }

    @objc private func handleMediaServicesReset(_ notification: Notification) {
        NSLog("[VoquillApp] Media services were reset")
        engine = nil
        let consumers = snapshot()
        guard !consumers.isEmpty else { return }
        consumers.forEach { $0.microphoneInterruptionBegan() }
        let resumed = (try? configureSession()) != nil && restart()
        consumers.forEach { $0.microphoneInterruptionEnded(resumed: resumed) }
    }
}

/// Converts tap buffers to a fixed format. The input format changes when the
/// route changes (AirPods, a call), so every consumer writes through one of
/// these instead of assuming the hardware format it started with.
final class PCMConverter {
    let outputFormat: AVAudioFormat
    private var converter: AVAudioConverter?

    init(outputFormat: AVAudioFormat) {
        self.outputFormat = outputFormat
    }

    func convert(_ buffer: AVAudioPCMBuffer) -> AVAudioPCMBuffer? {
        guard buffer.frameLength > 0 else { return nil }
        if buffer.format == outputFormat { return buffer }
        if converter?.inputFormat != buffer.format {
            converter = AVAudioConverter(from: buffer.format, to: outputFormat)
            converter?.downmix = true
        }
        guard let converter = converter else { return nil }

        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount(Double(buffer.frameLength) * ratio) + 64
        guard let output = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else { return nil }

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
            NSLog("[VoquillApp] Audio conversion failed: %@", error.localizedDescription)
            return nil
        }
        return output.frameLength > 0 ? output : nil
    }
}
