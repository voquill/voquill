import 'dart:async';
import 'dart:convert';
import 'dart:io';
import 'dart:math';

import 'package:app/model/note_model.dart';
import 'package:app/utils/note_utils.dart';
import 'package:app/utils/sse_utils.dart';
import 'package:http/http.dart' as http;

const noteAudioContentType = 'audio/aac';

const _queuedErrorCodes = {'too_many_processing', 'too_many_pending_uploads'};
const _uploadSessionExpiredCode = 'upload_session_expired';
const _uploadRejectedCode = 'upload_rejected';

/// GCS requires every chunk but the last to be a multiple of 256 KiB.
const _uploadChunkBytes = 32 * 256 * 1024;

/// A failed Notes request. [statusCode] is null when the server could not be
/// reached at all.
class NotesApiException implements Exception {
  final int? statusCode;
  final String code;
  final String message;
  final Map<String, dynamic>? details;

  const NotesApiException({
    required this.statusCode,
    required this.code,
    required this.message,
    this.details,
  });

  const NotesApiException.network(this.message)
    : statusCode = null,
      code = 'network_error',
      details = null;

  bool get isNetwork => statusCode == null;
  bool get isQuota => isQuotaError(toNoteError());
  bool get isNoteNotFound => code == 'note_not_found';

  /// The session is gone (404/410) or refused the bytes (400: the size did
  /// not match `sizeBytes`); either way a new session URL is needed.
  bool get needsNewUploadSession =>
      code == _uploadSessionExpiredCode || code == _uploadRejectedCode;

  /// The plan's limit of notes processing / uploads pending is reached;
  /// retrying later succeeds once another note finishes.
  bool get isQueued => _queuedErrorCodes.contains(code);

  /// The server already accepted this segment's audio and is processing it.
  bool get isSegmentProcessing => code == 'segment_processing';

  int? get retryAfterSeconds =>
      (details?['retryAfterSeconds'] as num?)?.toInt();

  /// Worth retrying later without user action.
  bool get isTransient {
    final status = statusCode;
    return status == null ||
        status == 408 ||
        status == 429 ||
        status == 401 ||
        status >= 500;
  }

  NoteError toNoteError() => NoteError(code: code, message: message);

  @override
  String toString() => message;
}

sealed class NoteAskEvent {
  const NoteAskEvent();
}

class NoteAskSourcesEvent extends NoteAskEvent {
  final List<NoteAskSource> sources;
  const NoteAskSourcesEvent(this.sources);
}

class NoteAskDeltaEvent extends NoteAskEvent {
  final String text;
  const NoteAskDeltaEvent(this.text);
}

class NoteAskDoneEvent extends NoteAskEvent {
  final String answer;
  const NoteAskDoneEvent(this.answer);
}

class NoteAskMessage {
  final String role;
  final String content;

  const NoteAskMessage({required this.role, required this.content});

  Map<String, dynamic> toJson() => {'role': role, 'content': content};
}

/// The only place that knows the `/v1/notes` HTTP contract and the GCS
/// resumable-upload protocol.
class NotesApi {
  NotesApi({
    required this.baseUrl,
    required this.getIdToken,
    http.Client? client,
  }) : _client = client ?? http.Client();

  final String baseUrl;
  final Future<String?> Function({bool forceRefresh}) getIdToken;
  final http.Client _client;

  static const _requestTimeout = Duration(seconds: 30);
  /// An 8 MiB chunk at 0.5 Mbit/s takes ~2.3 min; a request suspended with
  /// the app is abandoned after this and resumed from the session's offset.
  static const _chunkTimeout = Duration(minutes: 3);

  Future<NoteListPage> listNotes({int limit = 50, String? cursor}) async {
    final json = await _send(
      'GET',
      '/v1/notes',
      query: {'limit': '$limit', 'cursor': ?cursor},
    );
    return NoteListPage.fromJson(json);
  }

  Future<Note> getNote(String id) async {
    return _note(await _send('GET', '/v1/notes/$id'));
  }

  Future<Note> putNote(
    String id, {
    String? title,
    NoteTitleSource? titleSource,
    String? personalNotes,
    String? createdAt,
  }) async {
    final json = await _send(
      'PUT',
      '/v1/notes/$id',
      body: {
        'title': ?title,
        if (title != null && titleSource == NoteTitleSource.defaultTitle)
          'titleSource': 'default',
        'personalNotes': ?personalNotes,
        'createdAt': ?createdAt,
      },
    );
    return _note(json);
  }

  Future<Note> patchNote(
    String id, {
    String? title,
    String? personalNotes,
  }) async {
    final json = await _send(
      'PATCH',
      '/v1/notes/$id',
      body: {'title': ?title, 'personalNotes': ?personalNotes},
    );
    return _note(json);
  }

  Future<String> createSegmentUpload(
    String noteId,
    String segmentId, {
    required int durationMs,
    required int sizeBytes,
    int? index,
  }) async {
    final json = await _send(
      'POST',
      '/v1/notes/$noteId/segments/$segmentId/upload',
      body: {
        'contentType': noteAudioContentType,
        'durationMs': durationMs,
        'sizeBytes': sizeBytes,
        'index': ?index,
      },
    );
    return json['uploadUrl'] as String;
  }

  /// Bytes the upload session already holds. An expired session throws
  /// [NotesApiException.isUploadSessionExpired].
  Future<int> queryUploadOffset(String uploadUrl, int totalBytes) async {
    final response = await _guard(
      () => _client.put(
        Uri.parse(uploadUrl),
        headers: {'Content-Range': 'bytes */$totalBytes'},
      ),
    );
    return _uploadOffset(response, totalBytes);
  }

  /// Uploads [file] from [offset] in chunks; returns the offset the session
  /// confirmed. A failed chunk loses at most one chunk of progress.
  Future<int> uploadBytes(
    String uploadUrl,
    File file, {
    required int offset,
    required int totalBytes,
    void Function(int sentBytes)? onProgress,
  }) async {
    var current = offset;
    while (current < totalBytes) {
      final start = current;
      final end = min(start + _uploadChunkBytes, totalBytes);
      final request = http.StreamedRequest('PUT', Uri.parse(uploadUrl))
        ..headers['Content-Type'] = noteAudioContentType
        ..headers['Content-Range'] = 'bytes $start-${end - 1}/$totalBytes'
        ..contentLength = end - start;

      var sent = start;
      final body = file.openRead(start, end).map((chunk) {
        sent += chunk.length;
        onProgress?.call(sent);
        return chunk;
      });
      unawaited(request.sink.addStream(body).whenComplete(request.sink.close));

      final response = await _guard(() async {
        final streamed = await _client.send(request);
        return http.Response.fromStream(streamed);
      }, timeout: _chunkTimeout);
      current = _uploadOffset(response, totalBytes);
      onProgress?.call(current);
      if (current <= start && current < totalBytes) {
        throw const NotesApiException.network('The upload made no progress.');
      }
    }
    return current;
  }

  Future<Note> processNote(
    String id, {
    String? title,
    String? personalNotes,
  }) async {
    final json = await _send(
      'POST',
      '/v1/notes/$id/process',
      body: {'title': ?title, 'personalNotes': ?personalNotes},
    );
    return _note(json);
  }

  Future<Note> importNote({
    required String id,
    required String transcript,
    String? title,
    String? personalNotes,
    String? createdAt,
  }) async {
    final json = await _send(
      'POST',
      '/v1/notes/import',
      body: {
        'id': id,
        'transcript': transcript,
        'title': ?title,
        'personalNotes': ?personalNotes,
        'createdAt': ?createdAt,
      },
    );
    return _note(json);
  }

  Future<Note> regenerateNote(String id) async {
    return _note(await _send('POST', '/v1/notes/$id/regenerate', body: {}));
  }

  Future<void> deleteNote(String id) async {
    await _send('DELETE', '/v1/notes/$id');
  }

  /// Removes an untranscribed segment whose audio is gone. Missing segments
  /// are fine.
  Future<void> deleteSegment(String noteId, String segmentId) async {
    await _send('DELETE', '/v1/notes/$noteId/segments/$segmentId');
  }

  /// Aborts in-flight requests (sign-out).
  void close() => _client.close();

  Future<List<NoteSearchResult>> searchNotes(String query, {int? limit}) async {
    final json = await _send(
      'GET',
      '/v1/notes/search',
      query: {'q': query, if (limit != null) 'limit': '$limit'},
    );
    return (json['results'] as List)
        .map((e) => NoteSearchResult.fromJson(e as Map<String, dynamic>))
        .toList();
  }

  Stream<NoteAskEvent> ask({
    required String question,
    String? noteId,
    List<NoteAskMessage> history = const [],
  }) async* {
    final request = http.Request('POST', _uri('/v1/notes/ask'))
      ..headers.addAll(await _headers())
      ..headers['Accept'] = 'text/event-stream'
      ..body = jsonEncode({
        'question': question,
        'noteId': ?noteId,
        'history': history.map((m) => m.toJson()).toList(),
        'stream': true,
      });

    final streamed = await _guard(() => _client.send(request));
    if (streamed.statusCode >= 400) {
      final response = await http.Response.fromStream(streamed);
      throw _errorFrom(response);
    }

    try {
      await for (final event in parseSseStream(streamed.stream)) {
        final data = jsonDecode(event.data) as Map<String, dynamic>;
        switch (event.event) {
          case 'sources':
            yield NoteAskSourcesEvent(
              (data['sources'] as List)
                  .map((e) => NoteAskSource.fromJson(e as Map<String, dynamic>))
                  .toList(),
            );
          case 'delta':
            yield NoteAskDeltaEvent(data['text'] as String? ?? '');
          case 'done':
            yield NoteAskDoneEvent(data['answer'] as String? ?? '');
            return;
          case 'error':
            throw NotesApiException(
              statusCode: 502,
              code: data['code'] as String? ?? 'ask_failed',
              message: data['message'] as String? ?? 'Something went wrong.',
            );
        }
      }
    } on NotesApiException {
      rethrow;
    } on Exception catch (e) {
      throw NotesApiException.network('Connection lost: $e');
    }
  }

  Note _note(Map<String, dynamic> json) =>
      Note.fromJson(json['note'] as Map<String, dynamic>);

  Uri _uri(String path, [Map<String, String>? query]) {
    final uri = Uri.parse('$baseUrl$path');
    return query == null ? uri : uri.replace(queryParameters: query);
  }

  Future<Map<String, String>> _headers({bool forceRefresh = false}) async {
    final token = await getIdToken(forceRefresh: forceRefresh);
    if (token == null) {
      throw const NotesApiException(
        statusCode: 401,
        code: 'unauthenticated',
        message: 'You are signed out.',
      );
    }
    return {
      'Authorization': 'Bearer $token',
      'Content-Type': 'application/json',
    };
  }

  /// Sends a JSON request; a `401` is retried once with a refreshed token.
  Future<Map<String, dynamic>> _send(
    String method,
    String path, {
    Map<String, String>? query,
    Map<String, dynamic>? body,
  }) async {
    Future<http.Response> attempt({required bool forceRefresh}) async {
      final request = http.Request(method, _uri(path, query))
        ..headers.addAll(await _headers(forceRefresh: forceRefresh));
      if (body != null) request.body = jsonEncode(body);
      return _guard(() async {
        final streamed = await _client.send(request);
        return http.Response.fromStream(streamed);
      });
    }

    var response = await attempt(forceRefresh: false);
    if (response.statusCode == 401) {
      response = await attempt(forceRefresh: true);
    }
    if (response.statusCode >= 400) throw _errorFrom(response);
    if (response.body.isEmpty) return const {};
    return jsonDecode(response.body) as Map<String, dynamic>;
  }

  int _uploadOffset(http.Response response, int totalBytes) {
    final status = response.statusCode;
    if (status == 200 || status == 201) return totalBytes;
    if (status == 308) {
      final range = response.headers['range'];
      final match = range == null
          ? null
          : RegExp(r'bytes=0-(\d+)').firstMatch(range);
      return match == null ? 0 : int.parse(match.group(1)!) + 1;
    }
    final code = switch (status) {
      404 || 410 => _uploadSessionExpiredCode,
      400 => _uploadRejectedCode,
      _ => 'upload_failed',
    };
    throw NotesApiException(
      statusCode: status,
      code: code,
      message: 'Audio upload failed ($status).',
    );
  }

  NotesApiException _errorFrom(http.Response response) {
    try {
      final json = jsonDecode(response.body) as Map<String, dynamic>;
      final error = json['error'] as Map<String, dynamic>;
      return NotesApiException(
        statusCode: response.statusCode,
        code: error['code'] as String? ?? 'unknown',
        message: error['message'] as String? ?? 'Something went wrong.',
        details: error['details'] as Map<String, dynamic>?,
      );
    } catch (_) {
      return NotesApiException(
        statusCode: response.statusCode,
        code: 'http_${response.statusCode}',
        message: 'Something went wrong (${response.statusCode}).',
      );
    }
  }

  Future<T> _guard<T>(
    Future<T> Function() run, {
    Duration? timeout = _requestTimeout,
  }) async {
    try {
      final future = run();
      return await (timeout == null ? future : future.timeout(timeout));
    } on NotesApiException {
      rethrow;
    } on SocketException catch (e) {
      throw NotesApiException.network(e.message);
    } on HttpException catch (e) {
      throw NotesApiException.network(e.message);
    } on http.ClientException catch (e) {
      throw NotesApiException.network(e.message);
    } on TimeoutException {
      throw const NotesApiException.network('The request timed out.');
    } on HandshakeException catch (e) {
      throw NotesApiException.network(e.message);
    }
  }
}
