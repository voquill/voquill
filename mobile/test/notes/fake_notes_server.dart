import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:typed_data';

import 'package:app/actions/notes_actions.dart';
import 'package:app/api/local_note_store.dart';
import 'package:app/api/note_recorder_api.dart';
import 'package:app/api/notes_api.dart';
import 'package:http/http.dart' as http;
import 'package:flutter/services.dart';
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
  final Map<String, dynamic>? details;
  const FakeServerError(this.status, this.code, {this.details});
}

/// In-memory stand-in for `/v1/notes` and the GCS resumable-upload protocol
/// (docs/notes.md, second revision), with the same error codes. Failures are
/// injected per step: [errors] answers once with that error,
/// [networkFailures] drops the connection.
class FakeNotesServer {
  final notes = <String, Map<String, dynamic>>{};
  final segments = <String, Map<String, Map<String, dynamic>>>{};
  final uploadedBytes = <String, BytesBuilder>{};
  final uploadTotals = <String, int>{};
  final expiredSessions = <String>{};
  final calls = <String>[];

  /// Step name → remaining failures. Steps: put, session, query, bytes,
  /// process, get, list, patch, delete, import, deleteSegment.
  final networkFailures = <String, int>{};
  final errors = <String, FakeServerError>{};

  /// GET returns `processing` this many times after process before `ready`.
  int processingPolls = 1;
  final _pollsLeft = <String, int>{};
  bool failProcessing = false;

  /// Segments whose transcription fails with `unsupported_audio`.
  final failSegmentIds = <String>{};

  /// Plan limit of notes processing at once (imports included).
  int? maxProcessingNotes;

  /// While set, processing notes stay `processing`.
  bool isProcessingHeld = false;
  bool dropUploadHalfway = false;
  int _sessionCounter = 0;

  /// Completes a request only when the test says so.
  Completer<void>? holdPut;

  late final http.Client client = MockClient.streaming((request, body) async {
    try {
      return await _handle(request, body);
    } on _ErrorResponse catch (e) {
      return _error(e.error.status, e.error.code, details: e.error.details);
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
    calls.add('$method ${uri.path}');

    if (parts.isEmpty) {
      _fail('list');
      final all = notes.values.toList().reversed.toList();
      final limit = int.parse(uri.queryParameters['limit'] ?? '50');
      final start = int.parse(uri.queryParameters['cursor'] ?? '0');
      final page = all.skip(start).take(limit).toList();
      final next = start + page.length;
      return _json(200, {
        'notes': page.map(_publicNote).toList(),
        'nextCursor': next < all.length ? '$next' : null,
      });
    }
    if (parts.length == 1 && parts[0] == 'import') {
      _fail('import');
      final id = json['id'] as String;
      if (!notes.containsKey(id)) {
        _assertProcessingSlot(id);
        notes[id] = _newNote(
          id,
          source: 'import',
          title: json['title'] as String?,
        );
        segments[id] = {
          'import': {
            'id': 'import',
            'index': 0,
            'kind': 'import',
            'status': 'transcribed',
            'error': null,
            'durationMs': 0,
            'createdAt': '2026-01-01T00:00:00.000Z',
            'transcript': {'text': json['transcript'], 'utterances': []},
          },
        };
        _startProcessing(id);
      }
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
          await holdPut?.future;
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
          final note = _requireNote(id);
          if (note['status'] == 'processing') _advanceProcessing(id, note);
          return _json(200, {'note': _publicNote(note, withSegments: true)});
        case 'PATCH':
          _fail('patch');
          final note = _requireNote(id);
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
      final note = _requireNote(id);
      final noteSegments = segments[id] ?? {};
      if (noteSegments.isEmpty) return _error(409, 'no_audio');
      final missing = noteSegments.values
          .where(
            (s) =>
                s['status'] != 'transcribed' &&
                !_isComplete(s['uploadUrl'] as String?),
          )
          .map((s) => s['id'])
          .toList();
      if (missing.isNotEmpty) {
        return _error(409, 'audio_missing', details: {'segmentIds': missing});
      }
      if (json['personalNotes'] != null) {
        note['personalNotes'] = json['personalNotes'];
      }
      final hasNewAudio = noteSegments.values.any(
        (s) => s['status'] != 'transcribed',
      );
      if (note['status'] != 'processing' &&
          (note['status'] != 'ready' || hasNewAudio)) {
        _assertProcessingSlot(id);
        _startProcessing(id);
      }
      return _json(202, {'note': _publicNote(note)});
    }
    if (parts.length == 2 && parts[1] == 'regenerate') {
      _fail('regenerate');
      _startProcessing(id);
      return _json(202, {'note': _publicNote(_requireNote(id))});
    }
    if (parts.length == 3 && parts[1] == 'segments' && method == 'DELETE') {
      _fail('deleteSegment');
      _requireNote(id);
      final segment = segments[id]?[parts[2]];
      if (segment?['status'] == 'transcribed') {
        return _error(409, 'segment_transcribed');
      }
      segments[id]?.remove(parts[2]);
      return http.StreamedResponse(const Stream.empty(), 204);
    }
    if (parts.length == 4 && parts[3] == 'upload') {
      _fail('session');
      final segmentId = parts[2];
      final existing = segments[id]?[segmentId];
      if (existing?['status'] == 'transcribed') {
        return _error(409, 'segment_transcribed');
      }
      if (existing?['status'] == 'uploaded' &&
          notes[id]?['status'] == 'processing') {
        return _error(409, 'segment_processing');
      }
      notes.putIfAbsent(id, () => _newNote(id));
      final url = 'https://upload.test/$id/$segmentId/${_sessionCounter++}';
      final noteSegments = segments.putIfAbsent(id, () => {});
      noteSegments[segmentId] = {
        'id': segmentId,
        'index': json['index'] ?? existing?['index'] ?? noteSegments.length,
        'kind': 'audio',
        'status': 'uploading',
        'error': null,
        'durationMs': json['durationMs'],
        'createdAt': '2026-01-01T00:00:00.000Z',
        'transcript': null,
        'uploadUrl': url,
        'sizeBytes': json['sizeBytes'],
      };
      uploadTotals[url] = json['sizeBytes'] as int;
      notes[id]!['durationMs'] = noteSegments.values.fold<int>(
        0,
        (sum, s) => sum + (s['durationMs'] as int),
      );
      return _json(200, {'uploadUrl': url});
    }
    return _error(404, 'not_found');
  }

  Map<String, dynamic> _requireNote(String id) =>
      notes[id] ??
      (throw const _ErrorResponse(FakeServerError(404, 'note_not_found')));

  void _assertProcessingSlot(String id) {
    final limit = maxProcessingNotes;
    if (limit == null) return;
    final active = notes.entries
        .where((e) => e.key != id && e.value['status'] == 'processing')
        .length;
    if (active >= limit) {
      throw _ErrorResponse(
        FakeServerError(
          429,
          'too_many_processing',
          details: {'maxProcessingNotes': limit},
        ),
      );
    }
  }

  void _advanceProcessing(String id, Map<String, dynamic> note) {
    if (isProcessingHeld) return;
    final left = _pollsLeft[id] ?? 0;
    if (left > 0) {
      _pollsLeft[id] = left - 1;
      return;
    }
    if (failProcessing) {
      note['status'] = 'failed';
      note['error'] = {'code': 'transcription_failed', 'message': 'x'};
      return;
    }
    final noteSegments = (segments[id] ?? {}).values;
    for (final segment in noteSegments) {
      if (segment['status'] == 'transcribed') continue;
      final fails = failSegmentIds.contains(segment['id']);
      segment['status'] = fails ? 'failed' : 'transcribed';
      segment['error'] = fails
          ? {'code': 'unsupported_audio', 'message': 'x'}
          : null;
      segment['transcript'] = fails
          ? null
          : {'text': 'hello', 'utterances': []};
    }
    if (noteSegments.isNotEmpty &&
        noteSegments.every((s) => s['status'] == 'failed')) {
      note['status'] = 'failed';
      note['error'] = {'code': 'unsupported_audio', 'message': 'x'};
      return;
    }
    note['status'] = 'ready';
    note['generatedNotes'] = '# Summary';
    if (note['titleSource'] != 'user') {
      note['title'] = 'AI title';
      note['titleSource'] = 'ai';
    }
  }

  Future<http.StreamedResponse> _handleUpload(
    http.BaseRequest request,
    http.ByteStream body,
  ) async {
    final url = request.url.toString();
    final range = request.headers['Content-Range']!;
    if (expiredSessions.contains(url)) {
      await body.drain<void>();
      calls.add('EXPIRED $url');
      return http.StreamedResponse(const Stream.empty(), 410);
    }
    final received = uploadedBytes.putIfAbsent(url, BytesBuilder.new);
    if (range.startsWith('bytes */')) {
      calls.add('QUERY $url');
      await body.drain<void>();
      _fail('query');
      return _uploadStatus(url);
    }
    calls.add('UPLOAD $url $range');
    _fail('bytes');
    final match = RegExp(r'bytes (\d+)-(\d+)/(\d+)').firstMatch(range)!;
    final start = int.parse(match.group(1)!);
    final total = int.parse(match.group(3)!);
    if (total != uploadTotals[url]) {
      // The session is bound to the declared sizeBytes.
      await body.drain<void>();
      return http.StreamedResponse(const Stream.empty(), 400);
    }
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

  bool _isComplete(String? url) =>
      url != null && (uploadedBytes[url]?.length ?? -1) == uploadTotals[url];

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
    'title': title ?? 'Untitled note',
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
          .map(
            (s) => Map<String, dynamic>.from(s)
              ..remove('uploadUrl')
              ..remove('sizeBytes'),
          )
          .toList(),
  };

  http.StreamedResponse _json(int status, Map<String, dynamic> body) =>
      http.StreamedResponse(
        Stream.value(utf8.encode(jsonEncode(body))),
        status,
        headers: {'content-type': 'application/json'},
      );

  http.StreamedResponse _error(
    int status,
    String code, {
    Map<String, dynamic>? details,
  }) => _json(status, {
    'error': {'code': code, 'message': 'Error $code', 'details': ?details},
  });
}

class _ErrorResponse implements Exception {
  final FakeServerError error;
  const _ErrorResponse(this.error);
}

class FakeNoteRecorder implements NoteRecorder {
  final _events = StreamController<NoteRecorderEvent>.broadcast();
  NoteRecorderState? state;
  String? path;
  final calls = <String>[];
  bool failStart = false;
  String failCode = 'START_FAILED';
  int free = 10 * 1024 * 1024 * 1024;
  NoteRecorderActionEvent? pendingAction;

  /// Completes `start` only when the test says so.
  Completer<void>? holdStart;

  void emit(NoteRecorderEvent event) => _events.add(event);

  /// Simulates the native side switching to a new segment file.
  Future<String> rollOver() async {
    final current = state!;
    final next =
        '44444444-4444-4444-8444-${(calls.length).toString().padLeft(12, '0')}';
    path = '${File(path!).parent.path}/$next.aac';
    state = NoteRecorderState(
      noteId: current.noteId,
      segmentId: next,
      isPaused: false,
      segmentElapsedMs: 0,
      reason: NoteRecorderReason.rollover,
    );
    emit(NoteRecorderStateEvent(state!));
    return next;
  }

  @override
  Stream<NoteRecorderEvent> get events => _events.stream;

  @override
  Future<void> start({
    required String noteId,
    required String segmentId,
    required String path,
    required int priorElapsedMs,
    required int maxSegmentMs,
    required int maxSegmentBytes,
    required int maxNoteMs,
  }) async {
    calls.add('start');
    await holdStart?.future;
    if (failStart) throw PlatformException(code: failCode);
    if (state != null) throw PlatformException(code: 'START_FAILED');
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

  @override
  Future<int> freeBytes(String path) async => free;

  @override
  Future<void> excludeFromBackup(String path) async {}

  @override
  Future<bool> canShareMicrophone() async => true;
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
