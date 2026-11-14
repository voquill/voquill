import 'dart:async';
import 'dart:io';

import 'package:flutter/services.dart';
import 'package:record/record.dart';

/// 16 kHz mono PCM16 from the microphone, for dictating to the computer.
///
/// On iOS the audio comes from the app's one shared microphone engine, the
/// same tap that feeds keyboard dictation and meeting notes, so all three
/// run at once without fighting over the audio session. Android lets
/// several recorders of one app capture at once (Android 10+), so it keeps
/// using the `record` plugin there.
abstract class MicrophonePcmSource {
  factory MicrophonePcmSource() =>
      Platform.isIOS ? _SharedEnginePcmSource() : _RecordPluginPcmSource();

  Future<Stream<Uint8List>> start();

  Future<void> stop();
}

class _SharedEnginePcmSource implements MicrophonePcmSource {
  static const _channel = EventChannel('com.voquill.mobile/microphone_pcm');

  @override
  Future<Stream<Uint8List>> start() async =>
      _channel.receiveBroadcastStream().map((event) => event as Uint8List);

  @override
  Future<void> stop() async {}
}

class _RecordPluginPcmSource implements MicrophonePcmSource {
  final _recorder = AudioRecorder();

  @override
  Future<Stream<Uint8List>> start() => _recorder.startStream(
    const RecordConfig(
      encoder: AudioEncoder.pcm16bits,
      sampleRate: 16000,
      numChannels: 1,
    ),
  );

  @override
  Future<void> stop() async {
    try {
      await _recorder.stop();
    } finally {
      await _recorder.dispose();
    }
  }
}
