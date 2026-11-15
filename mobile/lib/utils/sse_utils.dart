import 'dart:convert';

class SseEvent {
  final String event;
  final String data;

  const SseEvent({required this.event, required this.data});
}

/// Incremental `text/event-stream` parser (WHATWG rules for the fields the
/// Notes API uses: `event`, multi-line `data`, comments, CRLF line endings).
class SseParser {
  String _event = '';
  final _data = <String>[];

  /// Feeds one line without its terminator; returns an event when the line
  /// completes one.
  SseEvent? addLine(String line) {
    if (line.isEmpty) return _dispatch();
    if (line.startsWith(':')) return null;

    final colon = line.indexOf(':');
    final field = colon < 0 ? line : line.substring(0, colon);
    var value = colon < 0 ? '' : line.substring(colon + 1);
    if (value.startsWith(' ')) value = value.substring(1);

    switch (field) {
      case 'event':
        _event = value;
      case 'data':
        _data.add(value);
    }
    return null;
  }

  SseEvent? _dispatch() {
    if (_data.isEmpty) {
      _event = '';
      return null;
    }
    final event = SseEvent(
      event: _event.isEmpty ? 'message' : _event,
      data: _data.join('\n'),
    );
    _event = '';
    _data.clear();
    return event;
  }
}

Stream<SseEvent> parseSseStream(Stream<List<int>> bytes) async* {
  final parser = SseParser();
  await for (final line
      in bytes.transform(utf8.decoder).transform(const LineSplitter())) {
    final event = parser.addLine(line);
    if (event != null) yield event;
  }
  final last = parser.addLine('');
  if (last != null) yield last;
}
