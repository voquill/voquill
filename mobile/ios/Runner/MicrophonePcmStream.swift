import AVFoundation
import Flutter
import Foundation

/// `com.voquill.mobile/microphone_pcm`: 16 kHz mono PCM16 from the shared
/// microphone engine, for dictating to the computer. Being one more consumer
/// of the same tap is what lets it run alongside a meeting recording and
/// keyboard dictation without touching the audio session.
final class MicrophonePcmStream: NSObject, FlutterStreamHandler, MicrophoneConsumer {
    private let channel: FlutterEventChannel
    private let converter = PCMConverter(
        outputFormat: AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16000, channels: 1, interleaved: true)!
    )
    private let lock = NSLock()
    private var sink: FlutterEventSink?

    init(binaryMessenger: FlutterBinaryMessenger) {
        channel = FlutterEventChannel(name: "com.voquill.mobile/microphone_pcm", binaryMessenger: binaryMessenger)
        super.init()
        channel.setStreamHandler(self)
    }

    func onListen(withArguments arguments: Any?, eventSink events: @escaping FlutterEventSink) -> FlutterError? {
        lock.lock()
        sink = events
        lock.unlock()
        do {
            try MicrophoneEngine.shared.attach(self)
            return nil
        } catch {
            lock.lock()
            sink = nil
            lock.unlock()
            return FlutterError(code: "START_FAILED", message: error.localizedDescription, details: nil)
        }
    }

    func onCancel(withArguments arguments: Any?) -> FlutterError? {
        MicrophoneEngine.shared.detach(self)
        lock.lock()
        sink = nil
        lock.unlock()
        return nil
    }

    func microphone(didReceive buffer: AVAudioPCMBuffer) {
        lock.lock()
        let isListening = sink != nil
        let output = isListening ? converter.convert(buffer) : nil
        lock.unlock()
        guard let output = output, let samples = output.int16ChannelData else { return }
        let data = Data(bytes: samples[0], count: Int(output.frameLength) * 2)
        DispatchQueue.main.async {
            self.lock.lock()
            let sink = self.sink
            self.lock.unlock()
            sink?(FlutterStandardTypedData(bytes: data))
        }
    }

    func microphoneInterruptionBegan() {}

    /// The engine could not get the microphone back (a call, Siri, a failed
    /// restart): tell Dart instead of going silent, so the dictation page
    /// can reopen the stream.
    func microphoneInterruptionEnded(resumed: Bool) {
        guard !resumed else { return }
        DispatchQueue.main.async {
            self.lock.lock()
            let sink = self.sink
            self.lock.unlock()
            sink?(FlutterError(code: "MIC_INTERRUPTED", message: "The microphone was interrupted", details: nil))
        }
    }
}
