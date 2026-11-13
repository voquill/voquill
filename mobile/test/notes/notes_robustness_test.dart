@Timeout(Duration(seconds: 15))
library;

import 'dart:async';
import 'dart:convert';
import 'dart:io';

import 'package:app/actions/notes_actions.dart';
import 'package:app/api/local_note_store.dart';
import 'package:app/api/note_recorder_api.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/state/app_state.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/note_utils.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:path/path.dart' as p;

import 'fake_notes_server.dart';

const _noteId = '11111111-1111-4111-8111-111111111111';
const _segmentA = '22222222-2222-4222-8222-222222222222';
const _segmentB = '33333333-3333-4333-8333-333333333333';
const _orphanNote = '55555555-5555-4555-8555-555555555555';
const _orphanSegment = '66666666-6666-4666-8666-666666666666';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory root;
  late FakeNotesServer server;
  late FakeNoteRecorder recorder;
  late LocalNoteStore store;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('notes_robustness_test');
    server = FakeNotesServer();
    recorder = FakeNoteRecorder();
    store = LocalNoteStore(root);
    setAppState(const AppState());
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('flutter.baseflow.com/permissions/methods'),
          (call) async => call.method == 'requestPermissions'
              ? {for (final p in call.arguments as List) p: 1}
              : 1,
        );
  });

  tearDown(() async {
    await disposeNotes();
    await root.delete(recursive: true);
  });

  NotesServices servicesFor(Directory dir) =>
      fakeServices(server: server, root: dir, recorder: recorder);

  Future<void> boot() async {
    await initializeNotes(servicesFor(root));
    await syncAllNotes();
  }

  Future<File> writeSegment(String fileName, List<int> bytes) async {
    final file = store.segmentFile(_noteId, fileName);
    await file.parent.create(recursive: true);
    return file.writeAsBytes(bytes);
  }

  Future<void> seed(
    List<LocalNoteSegment> segments, {
    LocalNotePhase phase = LocalNotePhase.pendingUpload,
    bool existsOnServer = false,
  }) {
    return store.saveSnapshot(
      LocalNotesSnapshot(
        localNotes: [
          LocalNote(
            id: _noteId,
            title: 'Meeting',
            createdAt: '2026-01-01T10:00:00.000Z',
            phase: phase,
            existsOnServer: existsOnServer,
            segments: segments,
          ),
        ],
      ),
    );
  }

  /// Waits for queued commands and file I/O that pumpEventQueue cannot see.
  Future<void> eventually(bool Function() condition) async {
    for (var i = 0; i < 200 && !condition(); i++) {
      await Future.delayed(const Duration(milliseconds: 10));
    }
  }

  LocalNote? local([String id = _noteId]) =>
      getAppState().notes.localNoteById[id];
  String snackbar() => getAppState().snackbar.message;

  group('uploads', () {
    test('an expired session is replaced and the upload starts over', () async {
      await writeSegment('$_segmentA.aac', adtsFrames(40));
      const stale = 'https://upload.test/expired';
      server.expiredSessions.add(stale);
      await seed([
        LocalNoteSegment(
          id: _segmentA,
          fileName: '$_segmentA.aac',
          uploadUrl: stale,
          uploadSizeBytes: adtsFrames(40).length,
        ),
      ]);
      await boot();

      expect(server.callCount('EXPIRED'), 1);
      expect(server.callCount('POST /v1/notes/$_noteId/segments'), 1);
      expect(local(), isNull);
    });

    test('a session made for another size is never reused', () async {
      // The recovered file grew after its session was created.
      await writeSegment('$_segmentA.aac', adtsFrames(60));
      await seed([
        const LocalNoteSegment(
          id: _segmentA,
          fileName: '$_segmentA.aac',
          uploadUrl: 'https://upload.test/old',
          uploadSizeBytes: 100,
        ),
      ]);
      await boot();

      expect(server.callCount('QUERY https://upload.test/old'), 0);
      expect(local(), isNull);
      expect(
        server.segments[_noteId]![_segmentA]!['sizeBytes'],
        adtsFrames(60).length,
      );
    });

    test(
      'storage refusing the bytes (400) gets a fresh session once',
      () async {
        await writeSegment('$_segmentA.aac', adtsFrames(20));
        const lying = 'https://upload.test/lying';
        server.uploadTotals[lying] = 5;
        await seed([
          LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            uploadUrl: lying,
            uploadSizeBytes: adtsFrames(20).length,
          ),
        ]);
        await boot();
        expect(server.callCount('POST /v1/notes/$_noteId/segments'), 1);
        expect(local(), isNull);
      },
    );

    test(
      'an already transcribed or processing segment is not uploaded again',
      () async {
        await writeSegment('$_segmentA.aac', adtsFrames(10));
        await seed([
          LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            durationMs: 640,
          ),
        ]);
        server.errors['session'] = const FakeServerError(
          409,
          'segment_transcribed',
        );
        server.notes[_noteId] = {
          'id': _noteId,
          'title': 'Meeting',
          'titleSource': 'default',
          'status': 'ready',
          'error': null,
          'source': 'recording',
          'personalNotes': '',
          'generatedNotes': '# x',
          'durationMs': 640,
          'createdAt': '2026-01-01T00:00:00.000Z',
          'updatedAt': '2026-01-01T00:00:00.000Z',
        };
        server.segments[_noteId] = {
          _segmentA: {
            'id': _segmentA,
            'index': 0,
            'kind': 'audio',
            'status': 'transcribed',
            'error': null,
            'durationMs': 640,
            'createdAt': '2026-01-01T00:00:00.000Z',
            'transcript': {'text': 'x', 'utterances': []},
          },
        };
        await boot();
        expect(server.callCount('UPLOAD'), 0);
        expect(local(), isNull);
      },
    );

    test(
      'a segment whose file is gone is dropped; the rest still processes',
      () async {
        await writeSegment('$_segmentA.aac', adtsFrames(10));
        await seed([
          const LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            durationMs: 640,
          ),
          const LocalNoteSegment(
            id: _segmentB,
            fileName: '$_segmentB.aac',
            durationMs: 640,
          ),
        ], existsOnServer: true);
        server.notes[_noteId] = {
          'id': _noteId,
          'title': 'Meeting',
          'titleSource': 'default',
          'status': 'draft',
          'error': null,
          'source': 'recording',
          'personalNotes': '',
          'generatedNotes': null,
          'durationMs': 0,
          'createdAt': '2026-01-01T00:00:00.000Z',
          'updatedAt': '2026-01-01T00:00:00.000Z',
        };
        await boot();

        expect(
          server.callCount('DELETE /v1/notes/$_noteId/segments/$_segmentB'),
          1,
        );
        expect(server.segments[_noteId]!.keys, [_segmentA]);
        expect(local(), isNull);
      },
    );
  });

  group('recovery', () {
    test(
      'a non-empty file that does not parse is kept for the server to judge',
      () async {
        await writeSegment(
          '$_segmentA.aac',
          utf8.encode('not an adts stream at all'),
        );
        await seed([
          const LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            isOpen: true,
          ),
        ], phase: LocalNotePhase.recording);
        await initializeNotes(servicesFor(root));

        final note = local()!;
        expect(note.phase, LocalNotePhase.paused);
        expect(note.segments.single.isOpen, isFalse);
        expect(note.segments.single.durationMs, 0);
        expect(
          store.segmentFile(_noteId, '$_segmentA.aac').existsSync(),
          isTrue,
        );
      },
    );

    test(
      'an unreadable snapshot is set aside and its audio recovered',
      () async {
        final file = File(
          p.join(store.noteDirectory(_orphanNote).path, '$_orphanSegment.aac'),
        );
        await file.parent.create(recursive: true);
        await file.writeAsBytes(adtsFrames(50));
        await root.create(recursive: true);
        await File(
          p.join(root.path, 'local_notes.json'),
        ).writeAsString('{"localNotes": [nope');

        await initializeNotes(servicesFor(root));
        final recovered = local(_orphanNote)!;
        expect(recovered.title, 'Recovered recording');
        expect(recovered.phase, LocalNotePhase.paused);
        expect(recovered.segments.single.id, _orphanSegment);
        expect(recovered.segments.single.durationMs, 3200);
        expect(
          root.listSync().map((e) => p.basename(e.path)),
          contains(startsWith('local_notes.json.unreadable-')),
        );
      },
    );

    test('audio the snapshot does not mention joins its note', () async {
      await writeSegment('$_segmentA.aac', adtsFrames(10));
      await writeSegment('$_segmentB.aac', adtsFrames(10));
      await seed([
        const LocalNoteSegment(
          id: _segmentA,
          fileName: '$_segmentA.aac',
          durationMs: 640,
        ),
      ], phase: LocalNotePhase.paused);
      await initializeNotes(servicesFor(root));
      expect(local()!.segments.map((s) => s.id), [_segmentA, _segmentB]);
    });
  });

  group('recording', () {
    test(
      'a native rollover adds a segment and closes the previous one',
      () async {
        await boot();
        final id = (await startNewNote())!;
        await File(recorder.path!).writeAsBytes(adtsFrames(25));
        final next = await recorder.rollOver();
        await eventually(() => (local(id)?.segments.length ?? 0) == 2);

        final note = local(id)!;
        expect(note.segments, hasLength(2));
        expect(note.segments.first.isOpen, isFalse);
        expect(note.segments.first.durationMs, 1600);
        expect(note.segments.last.id, next);
        expect(note.segments.last.isOpen, isTrue);
        expect(note.segments.map((s) => s.index), [0, 1]);

        await File(recorder.path!).writeAsBytes(adtsFrames(5));
        await stopRecording(id);
        await syncAllNotes();
        expect(server.segments[id]!.values.map((s) => s['index']), [0, 1]);
      },
    );

    test('the 8-hour limit stops the meeting and queues it', () async {
      await boot();
      final id = (await startNewNote())!;
      await File(recorder.path!).writeAsBytes(adtsFrames(5));
      recorder.state = NoteRecorderState(
        noteId: id,
        segmentId: recorder.state!.segmentId,
        isPaused: true,
        segmentElapsedMs: 320,
        reason: NoteRecorderReason.limit,
      );
      recorder.emit(NoteRecorderStateEvent(recorder.state!));
      await eventually(() => !(local(id)?.isCapturing ?? false));
      await syncAllNotes();

      expect(recorder.calls, contains('stop'));
      expect(snackbar(), contains('8-hour limit'));
      expect(local(id), isNull);
      expect(server.notes[id]!['status'], 'ready');
    });

    test('a note at the limit cannot be resumed', () async {
      await writeSegment('$_segmentA.aac', adtsFrames(5));
      await seed([
        LocalNoteSegment(
          id: _segmentA,
          fileName: '$_segmentA.aac',
          durationMs: noteMaxDuration.inMilliseconds,
        ),
      ], phase: LocalNotePhase.paused);
      await initializeNotes(servicesFor(root));
      await resumeRecording(_noteId);
      expect(recorder.calls, isNot(contains('start')));
      expect(snackbar(), contains('8-hour limit'));
    });

    test(
      'a failed write pauses with a storage message and keeps the audio',
      () async {
        await boot();
        final id = (await startNewNote())!;
        await File(recorder.path!).writeAsBytes(adtsFrames(5));
        final state = NoteRecorderState(
          noteId: id,
          segmentId: recorder.state!.segmentId,
          isPaused: true,
          segmentElapsedMs: 320,
          reason: NoteRecorderReason.writeFailed,
        );
        recorder.state = null;
        recorder.emit(NoteRecorderStateEvent(state));
        await eventually(() => snackbar().isNotEmpty);

        expect(local(id)!.phase, LocalNotePhase.paused);
        expect(snackbar(), contains('out of storage'));
        await resumeRecording(id);
        expect(
          local(id)!.segments,
          hasLength(2),
          reason: 'a new file after the failed one',
        );
      },
    );

    test('low storage refuses to start with a clear message', () async {
      await boot();
      recorder.failStart = true;
      recorder.failCode = noteRecorderLowStorageCode;
      expect(await startNewNote(), isNull);
      expect(snackbar(), contains('Not enough free storage'));
      expect(getAppState().notes.localNoteById, isEmpty);
    });

    test('low storage warns but records', () async {
      recorder.free = 100 * 1024 * 1024;
      await boot();
      expect(await startNewNote(), isNotNull);
      expect(snackbar(), contains('Storage is low'));
    });

    test(
      'double-tapping resume after a crash starts exactly one segment',
      () async {
        await writeSegment('$_segmentA.aac', adtsFrames(5));
        await seed([
          const LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            isOpen: true,
          ),
        ], phase: LocalNotePhase.recording);
        await initializeNotes(servicesFor(root));
        recorder.holdStart = Completer();
        final first = resumeRecording(_noteId);
        final second = resumeRecording(_noteId);
        await pumpEventQueue();
        expect(getAppState().notes.isRecorderBusy, isTrue);
        recorder.holdStart!.complete();
        await Future.wait([first, second]);

        expect(recorder.calls.where((c) => c == 'start'), hasLength(1));
        final note = local()!;
        expect(note.segments, hasLength(2));
        expect(note.segments.last.id, recorder.state!.segmentId);
        expect(note.segments.last.isOpen, isTrue);
        expect(getAppState().notes.isRecorderBusy, isFalse);
      },
    );

    test('double-tapping stop finishes the meeting once', () async {
      await boot();
      final id = (await startNewNote())!;
      await File(recorder.path!).writeAsBytes(adtsFrames(10));
      await Future.wait([stopRecording(id), stopRecording(id)]);
      await syncAllNotes();
      expect(local(id), isNull);
      expect(server.callCount('POST /v1/notes/$id/process'), 1);
    });

    test('a capture with no new audio on a finished note is undone', () async {
      await writeSegment('$_segmentA.aac', adtsFrames(10));
      await seed([
        LocalNoteSegment(
          id: _segmentA,
          fileName: '$_segmentA.aac',
          durationMs: 640,
        ),
      ]);
      await boot();
      expect(await resumeServerNote(_noteId), isTrue);
      await stopRecording(_noteId);
      expect(local(), isNull);
      expect(server.callCount('POST /v1/notes/$_noteId/process'), 1);
    });
  });

  group('server limits', () {
    test('imports beyond the processing limit queue and all finish', () async {
      server.maxProcessingNotes = 1;
      server.isProcessingHeld = true;
      await boot();
      await importTranscript(transcript: 'First');
      await importTranscript(transcript: 'Second');
      List<NoteDisplayState> states() => getAppState().notes.localNoteById.keys
          .map((id) => buildNoteView(getAppState().notes, id)!.state)
          .toList();
      await eventually(() => states().contains(NoteDisplayState.queued));
      expect(
        states(),
        containsAll([NoteDisplayState.processing, NoteDisplayState.queued]),
      );
      server.isProcessingHeld = false;

      for (
        var i = 0;
        i < 5 && getAppState().notes.localNoteById.isNotEmpty;
        i++
      ) {
        await syncAllNotes();
      }
      expect(getAppState().notes.localNoteById, isEmpty);
      expect(
        server.notes.values.where((n) => n['status'] == 'ready'),
        hasLength(2),
      );
    });

    test(
      'a regenerate cooldown shows how long to wait and is not retried',
      () async {
        await writeSegment('$_segmentA.aac', adtsFrames(10));
        await seed([
          LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            durationMs: 640,
          ),
        ]);
        await boot();
        server.errors['regenerate'] = const FakeServerError(
          429,
          'regenerate_cooldown',
          details: {'retryAfterSeconds': 90},
        );
        await regenerateNote(_noteId);
        expect(
          snackbar(),
          'The notes were just regenerated. Try again in 2 min.',
        );
        expect(server.callCount('POST /v1/notes/$_noteId/regenerate'), 1);
      },
    );
  });

  group('sessions and deletes', () {
    test('work for a signed-out user never reaches the next user', () async {
      await writeSegment('$_segmentA.aac', adtsFrames(10));
      await seed([
        LocalNoteSegment(
          id: _segmentA,
          fileName: '$_segmentA.aac',
          durationMs: 640,
        ),
      ]);
      server.holdPut = Completer();
      await initializeNotes(servicesFor(root));
      final pending = syncAllNotes();
      await pumpEventQueue();

      final otherRoot = await Directory.systemTemp.createTemp(
        'notes_other_user',
      );
      addTearDown(() async {
        await disposeNotes();
        await otherRoot.delete(recursive: true);
      });
      final otherServer = FakeNotesServer();
      await initializeNotes(
        fakeServices(server: otherServer, root: otherRoot, recorder: recorder),
      );
      server.holdPut!.complete();
      await pending;
      await pumpEventQueue();

      expect(getAppState().notes.localNoteById, isEmpty);
      expect(getAppState().notes.noteById.containsKey(_noteId), isFalse);
      expect(await LocalNoteStore(otherRoot).loadCachedNotes(), isEmpty);
      expect((await store.loadSnapshot()).localNotes.single.id, _noteId);
    });

    test(
      'deleting during a sync deletes on the server after the sync settles',
      () async {
        await writeSegment('$_segmentA.aac', adtsFrames(10));
        await seed([
          LocalNoteSegment(
            id: _segmentA,
            fileName: '$_segmentA.aac',
            durationMs: 640,
          ),
        ]);
        server.holdPut = Completer();
        await initializeNotes(servicesFor(root));
        final pending = syncAllNotes();
        await pumpEventQueue();
        await deleteNote(_noteId);
        server.holdPut!.complete();
        await pending;
        await eventually(
          () => server.callCount('DELETE /v1/notes/$_noteId') > 0,
        );

        final put = server.calls.indexOf('PUT /v1/notes/$_noteId');
        final delete = server.calls.lastIndexOf('DELETE /v1/notes/$_noteId');
        expect(delete, greaterThan(put));
        expect(server.notes.containsKey(_noteId), isFalse);
        expect(server.callCount('POST /v1/notes/$_noteId/segments'), 0);
      },
    );
  });

  group('list', () {
    Map<String, dynamic> serverNote(int i) => {
      'id': '00000000-0000-4000-8000-${i.toString().padLeft(12, '0')}',
      'title': 'Note $i',
      'titleSource': 'ai',
      'status': 'ready',
      'error': null,
      'source': 'recording',
      'personalNotes': '',
      'generatedNotes': 'x',
      'durationMs': 1000,
      'createdAt': '2026-01-01T00:00:00.000Z',
      'updatedAt': '2026-01-01T00:00:00.000Z',
    };

    test(
      'pages load once each and a failure waits for an explicit retry',
      () async {
        for (var i = 0; i < 120; i++) {
          final note = serverNote(i);
          server.notes[note['id'] as String] = note;
        }
        await boot();
        await pumpEventQueue();
        expect(getAppState().notes.serverNoteIds, hasLength(50));

        server.networkFailures['list'] = 1;
        await loadMoreNotes();
        expect(getAppState().notes.loadMoreStatus.isError, isTrue);
        final listCalls = server.callCount('GET /v1/notes');
        await loadMoreNotes();
        expect(
          server.callCount('GET /v1/notes'),
          listCalls,
          reason: 'no retry loop',
        );

        await loadMoreNotes(retry: true);
        await loadMoreNotes();
        expect(getAppState().notes.serverNoteIds, hasLength(120));
        expect(getAppState().notes.nextCursor, isNull);
      },
    );
  });
}
