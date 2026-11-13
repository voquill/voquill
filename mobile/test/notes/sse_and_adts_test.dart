import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app/api/notes_api.dart';
import 'package:app/utils/adts_utils.dart';
import 'package:app/utils/sse_utils.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:http/http.dart' as http;
import 'package:http/testing.dart';

import 'fake_notes_server.dart';

void main() {
  group('SSE', () {
    Future<List<SseEvent>> parse(List<String> chunks) =>
        parseSseStream(Stream.fromIterable(chunks.map(utf8.encode))).toList();

    test('parses events split across arbitrary chunks', () async {
      final events = await parse([
        'event: sou',
        'rces\ndata: {"sources":[]}\n',
        '\n: keepalive\n\nevent: delta\r\ndata: {"text":"a"}\r\n\r\n',
        'data: line1\ndata: line2\n\n',
        'event: done\ndata: {}',
      ]);
      expect(events.map((e) => e.event), [
        'sources',
        'delta',
        'message',
        'done',
      ]);
      expect(events[1].data, '{"text":"a"}');
      expect(events[2].data, 'line1\nline2');
    });

    test('ignores events without data and unknown fields', () async {
      final events = await parse(['event: ping\n\nid: 3\nretry: 10\n\n']);
      expect(events, isEmpty);
    });

    test('Ask streams sources, deltas and the final answer', () async {
      final server = FakeNotesServer();
      final api = NotesApi(
        baseUrl: 'https://api.test',
        getIdToken: ({bool forceRefresh = false}) async => 't',
        client: server.client,
      );
      final events = await api.ask(question: 'What?').toList();
      expect(events, hasLength(4));
      expect((events[0] as NoteAskSourcesEvent).sources.single.noteId, 'n1');
      expect(
        events.whereType<NoteAskDeltaEvent>().map((e) => e.text).join(),
        'Hello',
      );
      expect((events.last as NoteAskDoneEvent).answer, 'Hello');
    });

    test('Ask surfaces stream errors and HTTP errors', () async {
      final client = MockClient.streaming((request, _) async {
        if (request.url.queryParameters.isEmpty &&
            request.headers['Authorization'] == 'Bearer quota') {
          return http.StreamedResponse(
            Stream.value(
              utf8.encode(
                '{"error":{"code":"word_quota_exceeded","message":"No words"}}',
              ),
            ),
            403,
          );
        }
        return http.StreamedResponse(
          Stream.value(
            utf8.encode(
              'event: error\ndata: {"code":"ask_failed","message":"Nope"}\n\n',
            ),
          ),
          200,
        );
      });
      final failing = NotesApi(
        baseUrl: 'https://api.test',
        getIdToken: ({bool forceRefresh = false}) async => 'ok',
        client: client,
      );
      await expectLater(
        failing.ask(question: 'q').toList(),
        throwsA(
          isA<NotesApiException>().having((e) => e.code, 'code', 'ask_failed'),
        ),
      );
      final quota = NotesApi(
        baseUrl: 'https://api.test',
        getIdToken: ({bool forceRefresh = false}) async => 'quota',
        client: client,
      );
      await expectLater(
        quota.ask(question: 'q').toList(),
        throwsA(
          isA<NotesApiException>().having((e) => e.isQuota, 'isQuota', true),
        ),
      );
    });
  });

  group('ADTS duration', () {
    test('counts 1024 samples per frame at the header sample rate', () {
      final counter = AdtsDurationCounter()..add(adtsFrames(250));
      expect(counter.durationMs, 16000);
    });

    test('handles frames split across chunks', () {
      final bytes = adtsFrames(10);
      final counter = AdtsDurationCounter();
      for (var i = 0; i < bytes.length; i += 5) {
        counter.add(bytes.sublist(i, (i + 5).clamp(0, bytes.length)));
      }
      expect(counter.durationMs, 640);
    });

    test('ignores a truncated final frame and stops at garbage', () {
      final truncated = adtsFrames(3);
      final counter = AdtsDurationCounter()
        ..add([...adtsFrames(2), ...truncated.sublist(0, 20)]);
      expect(counter.durationMs, 128);

      final corrupt = AdtsDurationCounter()
        ..add([...adtsFrames(2), 0x00, 0x01, ...adtsFrames(2)]);
      expect(corrupt.durationMs, 128);
    });

    test('reads a file and treats a missing file as empty', () async {
      final dir = await Directory.systemTemp.createTemp('adts');
      final file = File('${dir.path}/a.aac')..writeAsBytesSync(adtsFrames(25));
      expect(await readAdtsDurationMs(file), 1600);
      expect(await readAdtsDurationMs(File('${dir.path}/missing.aac')), 0);
      await dir.delete(recursive: true);
    });
  });
}
