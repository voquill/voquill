import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:app/api/local_note_store.dart';
import 'package:app/api/note_recorder_api.dart';
import 'package:app/api/notes_api.dart';
import 'package:app/actions/notes_actions.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

/// Builds [count] ADTS frames at 16 kHz (64 ms of audio each).
Uint8List adtsFrames(int count, {int payloadBytes = 20}) {
  final builder = BytesBuilder();
  final frameLength = 7 + payloadBytes;
  for (var i = 0; i < count; i++) {
    builder.add([
      0xFF,
      0xF1,
      (1 << 6) | (8 << 2),
      (1 << 6) | ((frameLength >> 11) & 0x03),
      (frameLength >> 3) & 0xFF,
      ((frameLength & 0x07) << 5) | 0x1F,
      0xFC,
    ]);
    builder.add(List.filled(payloadBytes, i & 0xFF));
  }
  return builder.toBytes();
}

class FakeServerError {
  final int status;
  final String code;
  const FakeServerError(this.status, this.code);
}

/// In-memory stand-in for `/v1/notes` and the GCS resumable-upload protocol.
/// Failures are injected per step: a [FakeServerError] answers with that
/// error, `null` in [networkFailures] simulates a dropped connection.
class FakeNotesServer {
  final notes = <String, Map<String, dynamic>>{};
  final segments = <String, Map<String, Map<String, dynamic>>>{};
  final uploadedBytes = <String, BytesBuilder>{};
  final uploadTotals = <String, int>{};
  final calls = <String>[];

  /// Step name → remaining failures. Steps: put, session, query, bytes,
  /// process, get, list, patch, delete, import.
  final networkFailures = <String, int>{};
  final errors = <String, FakeServerError>{};

  /// GET returns `processing` this many times after process before `ready`.
  int processingPolls = 1;
  final _pollsLeft = <String, int>{};
  bool failProcessing = false;

  /// Segments whose transcription fails with `unsupported_audio`.
  final failSegmentIds = <String>{};
  bool dropUploadHalfway = false;
  int _sessionCounter = 0;

  late final http.Client client = MockClient.streaming((request, body) async {
    try {
      return await _handle(request, body);
    } on _ErrorResponse catch (e) {
      return _error(e.error.status, e.error.code);
    }
  });

  int callCount(String prefix) =>
      calls.where((c) => c.startsWith(prefix)).length;

  Future<http.StreamedResponse> _handle(
    http.BaseRequest request,
    http.ByteStream body,
  ) async {
    final uri = request.url;
    final method = request.method;
    if (uri.host == 'upload.test') return _handleUpload(request, body);

    final parts = uri.pathSegments.skip(2).toList();
    final bytes = await body.toBytes();
    final json = bytes.isEmpty
        ? <String, dynamic>{}
        : jsonDecode(utf8.decode(bytes)) as Map<String, dynamic>;
    calls.add("$method ${uri.path}");

    if (parts.isEmpty) {
      _fail('list');
      return _json(200, {
        'notes': notes.values.map(_publicNote).toList(),
        'nextCursor': null,
      });
    }
    if (parts.length == 1 && parts[0] == 'import') {
      _fail('import');
      final id = json['id'] as String;
      notes.putIfAbsent(
        id,
        () => _newNote(id, source: 'import', title: json['title'] as String?),
      );
      _startProcessing(id);
      return _json(202, {'note': _publicNote(notes[id]!)});
    }
    if (parts.length == 1 && parts[0] == 'ask') {
      return http.StreamedResponse(
        Stream.value(
          utf8.encode(
            'event: sources\ndata: {"sources":[{"noteId":"n1","title":"T"}]}\n\n'
            ': keepalive\n\n'
            'event: delta\ndata: {"text":"Hel"}\n\n'
            'event: delta\ndata: {"text":"lo"}\n\n'
            'event: done\ndata: {"answer":"Hello"}\n\n',
          ),
        ),
        200,
        headers: {'content-type': 'text/event-stream'},
      );
    }

    final id = parts[0];
    if (parts.length == 1) {
      switch (method) {
        case 'PUT':
          _fail('put');
          final note = notes.putIfAbsent(id, () => _newNote(id));
          if (json['title'] != null &&
              (json['titleSource'] != 'default' ||
                  note['titleSource'] == 'default')) {
            note['title'] = json['title'];
            note['titleSource'] = json['titleSource'] ?? 'user';
          }
          if (json['personalNotes'] != null) {
            note['personalNotes'] = json['personalNotes'];
          }
          return _json(200, {'note': _publicNote(note)});
        case 'GET':
          _fail('get');
          final note = notes[id];
          if (note == null) return _error(404, 'not_found');
          if (note['status'] == 'processing') {
            final left = _pollsLeft[id] ?? 0;
            if (left > 0) {
              _pollsLeft[id] = left - 1;
            } else if (failProcessing) {
              note['status'] = 'failed';
              note['error'] = {
                'code': 'transcription_failed',
                'message': 'Bad audio',
              };
            } else {
              final noteSegments = (segments[id] ?? {}).values;
              for (final segment in noteSegments) {
                final fails = failSegmentIds.contains(segment['id']);
                segment['status'] = fails ? 'failed' : 'transcribed';
                segment['error'] = fails
                    ? {'code': 'unsupported_audio', 'message': 'Bad'}
                    : null;
                segment['transcript'] = fails
                    ? null
                    : {'text': 'hello', 'utterances': []};
              }
              if (noteSegments.isNotEmpty &&
                  noteSegments.every((s) => s['status'] == 'failed')) {
                note['status'] = 'failed';
                note['error'] = {'code': 'unsupported_audio', 'message': 'Bad'};
                return _json(200, {
                  'note': _publicNote(note, withSegments: true),
                });
              }
              note['status'] = 'ready';
              note['generatedNotes'] = '# Summary';
              note['title'] = note['titleSource'] == 'user'
                  ? note['title']
                  : 'AI title';
              note['titleSource'] = note['titleSource'] == 'user'
                  ? 'user'
                  : 'ai';
            }
          }
          return _json(200, {'note': _publicNote(note, withSegments: true)});
        case 'PATCH':
          _fail('patch');
          final note = notes[id];
          if (note == null) return _error(404, 'not_found');
          note.addAll({
            if (json['title'] != null) ...{
              'title': json['title'],
              'titleSource': 'user',
            },
            if (json['personalNotes'] != null)
              'personalNotes': json['personalNotes'],
          });
          return _json(200, {'note': _publicNote(note)});
        case 'DELETE':
          _fail('delete');
          notes.remove(id);
          segments.remove(id);
          return http.StreamedResponse(const Stream.empty(), 204);
      }
    }
    if (parts.length == 2 && parts[1] == 'process') {
      _fail('process');
      final note = notes[id];
      if (note == null) return _error(404, 'not_found');
      final missing = (segments[id] ?? {}).values
          .where(
            (s) =>
                s['status'] != 'transcribed' &&
                !_isComplete(s['uploadUrl'] as String),
          )
          .map((s) => s['id'])
          .toList();
      if ((segments[id] ?? {}).isEmpty) return _error(409, 'no_audio');
      if (missing.isNotEmpty) {
        return _json(409, {
          'error': {
            'code': 'audio_missing',
            'message': 'missing',
            'details': {'segmentIds': missing},
          },
        });
      }
      if (json['personalNotes'] != null) {
        note['personalNotes'] = json['personalNotes'];
      }
      _startProcessing(id);
      return _json(202, {'note': _publicNote(note)});
    }
    if (parts.length == 2 && parts[1] == 'regenerate') {
      _startProcessing(id);
      return _json(202, {'note': _publicNote(notes[id]!)});
    }
    if (parts.length == 4 && parts[3] == 'upload') {
      _fail('session');
      final segmentId = parts[2];
      notes.putIfAbsent(id, () => _newNote(id));
      final url = 'https://upload.test/$id/$segmentId/${_sessionCounter++}';
      final noteSegments = segments.putIfAbsent(id, () => {});
      noteSegments[segmentId] = {
        'id': segmentId,
        'index':
            json['index'] ??
            noteSegments[segmentId]?['index'] ??
            noteSegments.length,
        'error': null,
        'kind': 'audio',
        'status': 'uploading',
        'durationMs': json['durationMs'],
        'createdAt': '2026-01-01T00:00:00.000Z',
        'transcript': null,
        'uploadUrl': url,
      };
      uploadTotals[url] = json['sizeBytes'] as int;
      return _json(200, {'uploadUrl': url});
    }
    return _error(404, 'not_found');
  }

  Future<http.StreamedResponse> _handleUpload(
    http.BaseRequest request,
    http.ByteStream body,
  ) async {
    final url = request.url.toString();
    final range = request.headers['Content-Range']!;
    final received = uploadedBytes.putIfAbsent(url, BytesBuilder.new);
    if (range.startsWith('bytes */')) {
      calls.add('QUERY $url');
      await body.drain<void>();
      _fail('query');
      return _uploadStatus(url);
    }
    calls.add('UPLOAD $url $range');
    _fail('bytes');
    final start = int.parse(
      RegExp(r'bytes (\d+)-').firstMatch(range)!.group(1)!,
    );
    if (start != received.length) {
      await body.drain<void>();
      return _uploadStatus(url);
    }
    if (dropUploadHalfway) {
      dropUploadHalfway = false;
      final all = await body.toBytes();
      received.add(all.sublist(0, all.length ~/ 2));
      throw http.ClientException('Connection reset');
    }
    received.add(await body.toBytes());
    return _uploadStatus(url);
  }

  bool _isComplete(String url) =>
      (uploadedBytes[url]?.length ?? -1) == uploadTotals[url];

  http.StreamedResponse _uploadStatus(String url) {
    if (_isComplete(url)) {
      return http.StreamedResponse(const Stream.empty(), 200);
    }
    final size = uploadedBytes[url]?.length ?? 0;
    return http.StreamedResponse(
      const Stream.empty(),
      308,
      headers: size > 0 ? {'range': 'bytes=0-${size - 1}'} : {},
    );
  }

  void _fail(String step) {
    final error = errors.remove(step);
    if (error != null) throw _ErrorResponse(error);
    final left = networkFailures[step] ?? 0;
    if (left > 0) {
      networkFailures[step] = left - 1;
      throw http.ClientException('Network is unreachable');
    }
  }

  void _startProcessing(String id) {
    notes[id]!['status'] = 'processing';
    notes[id]!['error'] = null;
    _pollsLeft[id] = processingPolls;
  }

  Map<String, dynamic> _newNote(
    String id, {
    String source = 'recording',
    String? title,
  }) => {
    'id': id,
    'title': title ?? 'Untitled meeting',
    'titleSource': title == null ? 'default' : 'user',
    'status': 'draft',
    'error': null,
    'source': source,
    'personalNotes': '',
    'generatedNotes': null,
    'durationMs': 0,
    'createdAt': '2026-01-01T00:00:00.000Z',
    'updatedAt': '2026-01-01T00:00:00.000Z',
  };

  Map<String, dynamic> _publicNote(
    Map<String, dynamic> note, {
    bool withSegments = false,
  }) => {
    ...note,
    if (withSegments)
      'segments': (segments[note['id']] ?? {}).values
          .map((s) => Map<String, dynamic>.from(s)..remove('uploadUrl'))
          .toList(),
  };

  http.StreamedResponse _json(int status, Map<String, dynamic> body) =>
      http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(body))),
        status,
        headers: {'content-type': 'application/json'},
      );

  http.StreamedResponse _error(int status, String code) => _json(status, {
    'error': {'code': code, 'message': 'Error $code'},
  });
}

class _ErrorResponse implements Exception {
  final FakeServerError error;
  _ErrorResponse(this.error);
}

class FakeNoteRecorder implements NoteRecorder {
  final _events = StreamController<NoteRecorderEvent>.broadcast();
  NoteRecorderState? state;
  String? path;
  final calls = <String>[];
  bool failStart = false;
  NoteRecorderActionEvent? pendingAction;

  void emit(NoteRecorderEvent event) => _events.add(event);

  @override
  Stream<NoteRecorderEvent> get events => _events.stream;

  @override
  Future<void> start({
    required String noteId,
    required String segmentId,
    required String path,
    required int priorElapsedMs,
  }) async {
    calls.add('start');
    if (failStart) throw Exception('mic busy');
    this.path = path;
    state = NoteRecorderState(
      noteId: noteId,
      segmentId: segmentId,
      isPaused: false,
      segmentElapsedMs: 0,
    );
  }

  NoteRecorderState? _set({required bool isPaused, int? elapsed}) {
    final current = state;
    if (current == null) return null;
    return state = NoteRecorderState(
      noteId: current.noteId,
      segmentId: current.segmentId,
      isPaused: isPaused,
      segmentElapsedMs: elapsed ?? current.segmentElapsedMs,
    );
  }

  @override
  Future<NoteRecorderState?> pause() async {
    calls.add('pause');
    return _set(isPaused: true, elapsed: 1000);
  }

  @override
  Future<NoteRecorderState?> resume() async {
    calls.add('resume');
    return _set(isPaused: false);
  }

  @override
  Future<NoteRecorderState?> stop() async {
    calls.add('stop');
    final current = state;
    state = null;
    return current;
  }

  @override
  Future<NoteRecorderState?> getState() async => state;

  @override
  Future<NoteRecorderActionEvent?> takePendingAction() async {
    final action = pendingAction;
    pendingAction = null;
    return action;
  }

  @override
  Future<void> setSyncActive(bool isActive) async {}
}

NotesServices fakeServices({
  required FakeNotesServer server,
  required Directory root,
  required FakeNoteRecorder recorder,
}) {
  return NotesServices(
    api: NotesApi(
      baseUrl: 'https://api.test',
      getIdToken: ({bool forceRefresh = false}) async => 'token',
      client: server.client,
    ),
    store: LocalNoteStore(root),
    recorder: recorder,
    pollInterval: Duration.zero,
    slowPollInterval: Duration.zero,
    retryDelays: const [],
  );
}
