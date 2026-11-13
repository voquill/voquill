import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/notes_state.dart';
import 'package:app/utils/note_utils.dart';
import 'package:flutter_test/flutter_test.dart';

Note _server(
  String id,
  String createdAt, {
  NoteStatus status = NoteStatus.ready,
}) => Note(
  id: id,
  title: 'Server $id',
  titleSource: NoteTitleSource.ai,
  status: status,
  source: NoteSource.recording,
  personalNotes: 'server notes',
  durationMs: 60000,
  createdAt: createdAt,
  updatedAt: createdAt,
);

LocalNote _local(String id, String createdAt, LocalNotePhase phase) =>
    LocalNote(
      id: id,
      title: 'Local $id',
      createdAt: createdAt,
      phase: phase,
      segments: const [
        LocalNoteSegment(id: 's', fileName: 's.aac', durationMs: 1000),
      ],
    );

void main() {
  final state = NotesState(
    serverNoteIds: const ['old', 'resumed', 'deleted', 'renamed'],
    noteById: {
      'old': _server('old', '2026-01-01T09:00:00Z'),
      'resumed': _server('resumed', '2026-01-02T09:00:00Z'),
      'deleted': _server('deleted', '2026-01-05T09:00:00Z'),
      'renamed': _server(
        'renamed',
        '2026-01-03T09:00:00Z',
        status: NoteStatus.processing,
      ),
    },
    localNoteById: {
      'resumed': _local(
        'resumed',
        '2026-01-02T09:00:00Z',
        LocalNotePhase.paused,
      ),
      'upload': _local(
        'upload',
        '2026-01-04T09:00:00Z',
        LocalNotePhase.uploading,
      ),
      'offline': _local(
        'offline',
        '2026-01-06T09:00:00Z',
        LocalNotePhase.pendingUpload,
      ),
    },
    pendingEditById: const {
      'renamed': NoteEdit(title: 'Renamed', personalNotes: 'edited'),
    },
    pendingDeleteIds: const ['deleted'],
    syncById: const {
      'upload': NoteSyncStatus(uploadProgress: 0.5),
      'offline': NoteSyncStatus(isWaitingForConnection: true),
    },
  );

  test(
    'merges local and server notes, capturing note pinned, newest first',
    () {
      final list = buildNoteList(state);
      expect(list.map((v) => v.id), [
        'resumed',
        'offline',
        'upload',
        'renamed',
        'old',
      ]);
      expect(list.map((v) => v.state), [
        NoteDisplayState.paused,
        NoteDisplayState.waitingForConnection,
        NoteDisplayState.uploading,
        NoteDisplayState.processing,
        NoteDisplayState.ready,
      ]);
    },
  );

  test('local copy wins over the server copy and edits win over both', () {
    final resumed = buildNoteView(state, 'resumed')!;
    expect(resumed.title, 'Local resumed');
    expect(resumed.server, isNotNull);
    expect(resumed.canAsk, isTrue);

    final renamed = buildNoteView(state, 'renamed')!;
    expect(renamed.title, 'Renamed');
    expect(renamed.personalNotes, 'edited');
    expect(renamed.canAsk, isFalse);

    expect(buildNoteView(state, 'upload')!.uploadProgress, 0.5);
    expect(buildNoteView(state, 'deleted'), isNull);
  });

  test('filters titles case-insensitively', () {
    expect(buildNoteList(state, query: 'LOCAL').map((v) => v.id), [
      'resumed',
      'offline',
      'upload',
    ]);
  });

  test('formats durations', () {
    expect(formatNoteDuration(5000), '0:05');
    expect(formatNoteDuration(65000), '1:05');
    expect(formatNoteDuration(3723000), '1:02:03');
  });
}
