import 'dart:io';
import 'dart:typed_data';

const _adtsSampleRates = [
  96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, //
  11025, 8000, 7350,
];
const _samplesPerBlock = 1024;
const _headerLength = 7;

/// Counts the audio in an ADTS (raw AAC) stream frame by frame. Meeting audio
/// is recorded as ADTS because every frame is self-describing: a file cut off
/// by a crash or force quit is still valid up to its last complete frame.
class AdtsDurationCounter {
  final _pending = BytesBuilder(copy: false);
  double _seconds = 0;
  bool _isCorrupt = false;

  int get durationMs => (_seconds * 1000).round();

  void add(List<int> chunk) {
    if (_isCorrupt) return;
    _pending.add(chunk);
    final bytes = _pending.takeBytes();
    var offset = 0;
    while (bytes.length - offset >= _headerLength) {
      if (bytes[offset] != 0xFF || (bytes[offset + 1] & 0xF0) != 0xF0) {
        _isCorrupt = true;
        return;
      }
      final rateIndex = (bytes[offset + 2] >> 2) & 0x0F;
      final frameLength =
          ((bytes[offset + 3] & 0x03) << 11) |
          (bytes[offset + 4] << 3) |
          (bytes[offset + 5] >> 5);
      if (rateIndex >= _adtsSampleRates.length || frameLength < _headerLength) {
        _isCorrupt = true;
        return;
      }
      if (bytes.length - offset < frameLength) break;
      final blocks = (bytes[offset + 6] & 0x03) + 1;
      _seconds += blocks * _samplesPerBlock / _adtsSampleRates[rateIndex];
      offset += frameLength;
    }
    _pending.add(Uint8List.sublistView(bytes, offset));
  }
}

Future<int> readAdtsDurationMs(File file) async {
  if (!await file.exists()) return 0;
  final counter = AdtsDurationCounter();
  await for (final chunk in file.openRead()) {
    counter.add(chunk);
  }
  return counter.durationMs;
}
