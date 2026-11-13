@Timeout(Duration(seconds: 10))
library;

import 'dart:io';

import 'package:app/actions/notes_actions.dart';
import 'package:app/api/local_note_store.dart';
import 'package:app/api/note_recorder_api.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/app_state.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/note_utils.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

import 'fake_notes_server.dart';

const _noteId = '11111111-1111-4111-8111-111111111111';
const _segmentA = '22222222-2222-4222-8222-222222222222';
const _segmentB = '33333333-3333-4333-8333-333333333333';

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  late Directory root;
  late FakeNotesServer server;
  late FakeNoteRecorder recorder;
  late LocalNoteStore store;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('notes_sync_test');
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

  Future<void> boot() async {
    await initializeNotes(
      fakeServices(server: server, root: root, recorder: recorder),
    );
    await syncAllNotes();
  }

  /// A stopped meeting waiting for upload, as persisted before a restart.
  Future<void> seedStoppedNote({
    List<String> segmentIds = const [_segmentA],
  }) async {
    for (final id in segmentIds) {
      final file = store.segmentFile(_noteId, '$id.aac');
      await file.parent.create(recursive: true);
      await file.writeAsBytes(adtsFrames(50));
    }
    await store.saveSnapshot(
      LocalNotesSnapshot(
        localNotes: [
          LocalNote(
            id: _noteId,
            title: 'Meeting',
            createdAt: '2026-01-01T10:00:00.000Z',
            personalNotes: 'mine',
            phase: LocalNotePhase.pendingUpload,
            segments: [
              for (final id in segmentIds)
                LocalNoteSegment(id: id, fileName: '$id.aac', durationMs: 3200),
            ],
          ),
        ],
      ),
    );
  }

  LocalNote? local() => getAppState().notes.localNoteById[_noteId];
  bool audioExists() =>
      store.segmentFile(_noteId, '$_segmentA.aac').existsSync();

  test(
    'finish flow uploads, processes, stores the result, then deletes audio',
    () async {
      await seedStoppedNote(segmentIds: [_segmentA, _segmentB]);
      await boot();

      expect(local(), isNull);
      expect(audioExists(), isFalse);
      final note = getAppState().notes.noteById[_noteId]!;
      expect(note.status, NoteStatus.ready);
      expect(note.generatedNotes, '# Summary');
      expect(note.segments, hasLength(2));
      expect(server.notes[_noteId]!['personalNotes'], 'mine');
      expect(server.notes[_noteId]!['title'], 'AI title');
      expect(server.callCount('PUT /v1/notes/'), 1);
      expect(server.callCount('POST /v1/notes/$_noteId/process'), 1);

      final cached = await store.loadCachedNotes();
      expect(cached.single.generatedNotes, '# Summary');
      expect((await store.loadSnapshot()).localNotes, isEmpty);
    },
  );

  for (final step in ['put', 'session', 'bytes', 'process', 'get']) {
    test(
      'a network failure at "$step" keeps the audio and resumes on retry',
      () async {
        await seedStoppedNote();
        server.networkFailures[step] = 1;
        await boot();

        expect(audioExists(), isTrue);
        final failedOver = local()!;
        expect(failedOver.phase, isNot(LocalNotePhase.failed));
        expect(
          buildNoteView(getAppState().notes, _noteId)!.state,
          NoteDisplayState.waitingForConnection,
        );

        await syncAllNotes();
        expect(local(), isNull);
        expect(audioExists(), isFalse);
        expect(getAppState().notes.noteById[_noteId]!.status, NoteStatus.ready);
        expect(
          server.callCount('POST /v1/notes/$_noteId/process'),
          step == 'process' ? 2 : 1,
        );
      },
    );
  }

  test('restart after a failure resumes from the persisted step', () async {
    await seedStoppedNote(segmentIds: [_segmentA, _segmentB]);
    server.networkFailures['process'] = 1;
    await boot();
    expect(server.callCount('UPLOAD'), 2);
    expect(local()!.segments.every((s) => s.isUploaded), isTrue);

    await disposeNotes();
    await boot();

    expect(
      server.callCount('UPLOAD'),
      2,
      reason: 'uploaded segments are not re-sent',
    );
    expect(local(), isNull);
    expect(audioExists(), isFalse);
  });

  test('an upload cut off halfway resumes from the server offset', () async {
    await seedStoppedNote();
    server.dropUploadHalfway = true;
    await boot();
    expect(local()!.segments.single.isUploaded, isFalse);
    expect(local()!.segments.single.uploadUrl, isNotNull);

    await syncAllNotes();
    final uploads = server.calls.where((c) => c.startsWith('UPLOAD')).toList();
    expect(uploads, hasLength(2));
    expect(uploads.last, isNot(contains('bytes 0-')));
    expect(server.callCount('QUERY'), 1);
    expect(local(), isNull);
  });

  test(
    'server-side failure keeps audio; Retry re-processes without re-uploading',
    () async {
      await seedStoppedNote();
      server.failProcessing = true;
      await boot();

      expect(local()!.phase, LocalNotePhase.failed);
      expect(local()!.error!.code, 'transcription_failed');
      expect(audioExists(), isTrue);

      server.failProcessing = false;
      await retryNote(_noteId);
      expect(local(), isNull);
      expect(audioExists(), isFalse);
      expect(server.callCount('UPLOAD'), 1);
      expect(server.callCount('POST /v1/notes/$_noteId/process'), 2);
    },
  );

  test('quota errors fail the note with the code and keep the audio', () async {
    await seedStoppedNote();
    final availableAt = DateTime.now().add(const Duration(days: 3));
    server.errors['process'] = FakeServerError(
      403,
      'audio_quota_exceeded',
      details: {
        'usedMs': 6900000,
        'allowanceMs': 7200000,
        'requestedMs': 1800000,
        'windowDays': 30,
        'nextReleaseAt': null,
        'availableAt': availableAt.toUtc().toIso8601String(),
      },
    );
    await boot();

    expect(local()!.phase, LocalNotePhase.failed);
    expect(isQuotaError(local()!.error), isTrue);
    expect(
      describeNoteError(local()!.error),
      allOf(contains('2 h of meeting audio'), contains('This fits again on ')),
    );
    expect(audioExists(), isTrue);
  });

  test('audio the server lost is uploaded again before processing', () async {
    await seedStoppedNote();
    await store.saveSnapshot(
      LocalNotesSnapshot(
        localNotes: [
          (await store.loadSnapshot()).localNotes.single.draft()
            ..segments = [
              const LocalNoteSegment(
                id: _segmentA,
                fileName: '$_segmentA.aac',
                durationMs: 3200,
                isUploaded: true,
                uploadUrl: 'https://upload.test/stale',
              ),
            ],
        ],
      ),
    );
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
    server.segments[_noteId] = {
      _segmentA: {
        'id': _segmentA,
        'status': 'uploading',
        'uploadUrl': 'https://upload.test/stale',
      },
    };
    server.uploadTotals['https://upload.test/stale'] = 99;
    await boot();

    expect(server.callCount('POST /v1/notes/$_noteId/process'), 2);
    expect(server.callCount('UPLOAD'), 1);
    expect(local(), isNull);
  });

  test('recording: start, pause, resume, stop runs the finish flow', () async {
    await boot();
    final id = (await startNewNote())!;
    var note = getAppState().notes.localNoteById[id]!;
    expect(note.phase, LocalNotePhase.recording);
    expect(note.title, startsWith('Meeting · '));
    await File(recorder.path!).writeAsBytes(adtsFrames(100));

    await pauseRecording(id);
    note = getAppState().notes.localNoteById[id]!;
    expect(note.phase, LocalNotePhase.paused);
    expect(note.segments.single.durationMs, 1000);

    await resumeRecording(id);
    expect(
      getAppState().notes.localNoteById[id]!.phase,
      LocalNotePhase.recording,
    );
    expect(recorder.calls, ['start', 'pause', 'resume']);

    await updateNotePersonalNotes(id, 'decisions');
    await stopRecording(id);
    await syncAllNotes();

    expect(getAppState().notes.localNoteById[id], isNull);
    expect(server.notes[id]!['personalNotes'], 'decisions');
    expect(server.segments[id]!.values.single['durationMs'], 6400);
  });

  test(
    'a recording interrupted by a crash comes back paused with its audio',
    () async {
      await boot();
      final id = (await startNewNote())!;
      await File(
        recorder.path!,
      ).writeAsBytes([...adtsFrames(30), 0xFF, 0xF1, 0x60]);
      await disposeNotes();
      recorder.state = null;

      await boot();
      final note = getAppState().notes.localNoteById[id]!;
      expect(note.phase, LocalNotePhase.paused);
      expect(note.segments.single.isOpen, isFalse);
      expect(note.segments.single.durationMs, 1920);
      expect(note.recordingStartedAt, isNull);

      await resumeRecording(id);
      expect(getAppState().notes.localNoteById[id]!.segments, hasLength(2));
    },
  );

  test(
    'a recording still running natively is adopted after a restart',
    () async {
      await boot();
      final id = (await startNewNote())!;
      final segmentId = recorder.state!.segmentId;
      await disposeNotes();
      recorder.calls.clear();
      recorder.state = NoteRecorderState(
        noteId: id,
        segmentId: segmentId,
        isPaused: false,
        segmentElapsedMs: 5000,
      );

      await boot();
      final note = getAppState().notes.localNoteById[id]!;
      expect(note.phase, LocalNotePhase.recording);
      expect(note.elapsedMs(DateTime.now()), greaterThanOrEqualTo(5000));
      expect(recorder.calls.where((c) => c == 'stop'), isEmpty);
    },
  );

  test('native interruption events pause and resume the note', () async {
    await boot();
    final id = (await startNewNote())!;
    final segmentId = recorder.state!.segmentId;
    recorder.emit(
      NoteRecorderStateEvent(
        NoteRecorderState(
          noteId: id,
          segmentId: segmentId,
          isPaused: true,
          segmentElapsedMs: 4200,
        ),
      ),
    );
    await pumpEventQueue();
    expect(getAppState().notes.localNoteById[id]!.phase, LocalNotePhase.paused);
    expect(
      getAppState().notes.localNoteById[id]!.segments.single.durationMs,
      4200,
    );
  });

  test(
    'only one recording at a time and a failed mic start leaves nothing behind',
    () async {
      await boot();
      recorder.failStart = true;
      expect(await startNewNote(), isNull);
      expect(getAppState().notes.localNoteById, isEmpty);

      recorder.failStart = false;
      expect(await startNewNote(), isNotNull);
      expect(await startNewNote(), isNull);
      expect(getAppState().notes.localNoteById, hasLength(1));
    },
  );

  test('imports queue offline and process once connected', () async {
    server.networkFailures['import'] = 2;
    await boot();
    await importTranscript(transcript: 'A: hi\nB: hello');
    await importTranscript(transcript: 'Second', title: 'Standup');
    await pumpEventQueue();

    final notes = getAppState().notes.localNoteById.values.toList();
    expect(notes, hasLength(2));
    await syncAllNotes();
    expect(getAppState().notes.localNoteById, isEmpty);
    expect(
      server.notes.values.map((n) => n['title']),
      containsAll(['AI title', 'Standup']),
    );
  });

  test('deleting offline queues the server delete', () async {
    await seedStoppedNote();
    server.networkFailures['put'] = 1;
    server.networkFailures['delete'] = 1;
    await boot();
    await deleteNote(_noteId);
    await pumpEventQueue();

    expect(local(), isNull);
    expect(audioExists(), isFalse);
    expect(getAppState().notes.pendingDeleteIds, [_noteId]);
    await syncAllNotes();
    expect(getAppState().notes.pendingDeleteIds, isEmpty);
  });

  test('edits to server notes are queued and patched', () async {
    await seedStoppedNote();
    await boot();
    server.networkFailures['patch'] = 1;
    await updateNoteTitle(_noteId, 'Renamed');
    await syncAllNotes();
    expect(getAppState().notes.pendingEditById, contains(_noteId));
    expect(buildNoteView(getAppState().notes, _noteId)!.title, 'Renamed');

    await syncAllNotes();
    expect(getAppState().notes.pendingEditById, isEmpty);
    expect(server.notes[_noteId]!['title'], 'Renamed');
    expect(server.notes[_noteId]!['titleSource'], 'user');
  });

  test(
    'resuming a ready note records into a new segment and reprocesses',
    () async {
      await seedStoppedNote();
      await boot();
      expect(await resumeServerNote(_noteId), isTrue);
      final note = local()!;
      expect(note.existsOnServer, isTrue);
      expect(
        note.priorDurationMs,
        getAppState().notes.noteById[_noteId]!.durationMs,
      );
      await File(recorder.path!).writeAsBytes(adtsFrames(10));
      await stopRecording(_noteId);
      await syncAllNotes();

      expect(local(), isNull);
      expect(server.segments[_noteId], hasLength(2));
      expect(server.notes[_noteId]!['title'], 'AI title');
    },
  );

  test('a ready note keeps only the audio of segments that failed', () async {
    await seedStoppedNote(segmentIds: [_segmentA, _segmentB]);
    server.failSegmentIds.add(_segmentB);
    await boot();

    final note = local()!;
    expect(note.phase, LocalNotePhase.ready);
    expect(note.segments.map((s) => s.id), [_segmentB]);
    expect(
      note.segments.single.isUploaded,
      isFalse,
      reason: 'unsupported_audio needs the segment uploaded again',
    );
    expect(audioExists(), isFalse);
    expect(store.segmentFile(_noteId, '$_segmentB.aac').existsSync(), isTrue);
    final view = buildNoteView(getAppState().notes, _noteId)!;
    expect(view.state, NoteDisplayState.ready);
    expect(view.failedSegmentError?.code, 'unsupported_audio');
    expect(view.title, 'AI title');

    server.failSegmentIds.clear();
    await retryNote(_noteId);
    expect(local(), isNull);
    expect(server.callCount('UPLOAD'), 3);
  });

  test('all segments failing fails the note and keeps everything', () async {
    await seedStoppedNote();
    server.failSegmentIds.add(_segmentA);
    await boot();
    expect(local()!.phase, LocalNotePhase.failed);
    expect(audioExists(), isTrue);
  });

  test('audio the server lost is uploaded again on Retry', () async {
    await seedStoppedNote();
    await boot();
    expect(local(), isNull);
    // Simulate a later resume whose segment the server reports lost.
    expect(await resumeServerNote(_noteId), isTrue);
    await File(recorder.path!).writeAsBytes(adtsFrames(10));
    final newSegment = recorder.state!.segmentId;
    server.errors['process'] = FakeServerError(
      409,
      'audio_missing',
      details: {
        'segmentIds': [newSegment],
      },
    );
    await stopRecording(_noteId);
    await syncAllNotes();
    expect(local(), isNull);
    expect(server.callCount('UPLOAD'), 3);
  });

  test('a processing note re-sends process after a restart', () async {
    await seedStoppedNote();
    server.networkFailures['get'] = 1;
    await boot();
    expect(local()!.phase, LocalNotePhase.processing);
    await disposeNotes();

    await boot();
    expect(server.callCount('POST /v1/notes/$_noteId/process'), 2);
    expect(local(), isNull);
  });

  test('recording creates the note on the server and syncs My notes', () async {
    await boot();
    final id = (await startNewNote())!;
    await pumpEventQueue();
    expect(server.notes[id]!['titleSource'], 'default');
    expect(getAppState().notes.localNoteById[id]!.existsOnServer, isTrue);

    await updateNotePersonalNotes(id, 'agenda');
    await syncAllNotes();
    expect(server.notes[id]!['personalNotes'], 'agenda');
    expect(getAppState().notes.pendingEditById, isEmpty);
  });

  test('segments are uploaded with their index', () async {
    await boot();
    final id = (await startNewNote())!;
    await File(recorder.path!).writeAsBytes(adtsFrames(5));
    recorder.state = null;
    await pauseRecording(id);
    await disposeNotes();
    await boot();
    await resumeRecording(id);
    await File(recorder.path!).writeAsBytes(adtsFrames(5));
    await stopRecording(id);
    await syncAllNotes();

    final indexes = server.segments[id]!.values.map((s) => s['index']);
    expect(indexes, [0, 1]);
  });
}
