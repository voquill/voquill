import 'dart:async';
import 'dart:io';

import 'package:app/api/local_note_store.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  late Directory root;

  setUp(() async {
    root = await Directory.systemTemp.createTemp('local_note_store_test');
  });

  tearDown(() => root.delete(recursive: true));

  test('snapshot round-trips every field', () async {
    const snapshot = LocalNotesSnapshot(
      localNotes: [
        LocalNote(
          id: 'a',
          source: NoteSource.imported,
          title: 'Standup',
          titleSource: NoteTitleSource.user,
          personalNotes: 'notes',
          createdAt: '2026-01-01T10:00:00.000Z',
          phase: LocalNotePhase.failed,
          segments: [
            LocalNoteSegment(
              id: 's1',
              fileName: 's1.aac',
              durationMs: 1200,
              isOpen: true,
              uploadUrl: 'https://upload/1',
              isUploaded: true,
            ),
          ],
          priorDurationMs: 5000,
          existsOnServer: true,
          recordingStartedAt: '2026-01-01T10:01:00.000Z',
          error: NoteError(code: 'x', message: 'y'),
        ),
      ],
      pendingEdits: {'b': NoteEdit(title: 'T')},
      pendingDeleteIds: ['c'],
    );

    await LocalNoteStore(root).saveSnapshot(snapshot);
    final loaded = await LocalNoteStore(root).loadSnapshot();
    expect(loaded, snapshot);
  });

  test('missing files load as empty', () async {
    final store = LocalNoteStore(root);
    expect(await store.loadSnapshot(), const LocalNotesSnapshot());
    expect(await store.loadCachedNotes(), isEmpty);
  });

  test('writes are serialized and the last one wins', () async {
    final store = LocalNoteStore(root);
    for (var i = 0; i < 20; i++) {
      unawaited(
        store.saveSnapshot(LocalNotesSnapshot(pendingDeleteIds: ['$i'])),
      );
    }
    await store.flush();
    expect((await store.loadSnapshot()).pendingDeleteIds, ['19']);
    expect(File('${root.path}/local_notes.json.tmp').existsSync(), isFalse);
  });

  test('cache drops segments and note files delete per note', () async {
    final store = LocalNoteStore(root);
    const note = Note(
      id: 'n',
      title: 'T',
      titleSource: NoteTitleSource.ai,
      status: NoteStatus.ready,
      source: NoteSource.recording,
      generatedNotes: '# Notes',
      durationMs: 10,
      createdAt: '2026-01-01T10:00:00.000Z',
      updatedAt: '2026-01-01T10:00:00.000Z',
      segments: [],
    );
    await store.saveCachedNotes([note]);
    expect((await store.loadCachedNotes()).single, note.withoutSegments());

    await store.writeImportTranscript('n', 'hello');
    await store.segmentFile('n', 'a.aac').writeAsBytes([1]);
    await store.segmentFile('m', 'b.aac').create(recursive: true);
    await store.deleteNoteFiles('n');
    expect(store.noteDirectory('n').existsSync(), isFalse);
    expect(store.segmentFile('m', 'b.aac').existsSync(), isTrue);
  });
}
