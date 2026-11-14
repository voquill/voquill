import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/notes_state.dart';
import 'package:app/utils/note_utils.dart';
import 'package:flutter_test/flutter_test.dart';

Note _note(String id, DateTime local, {int minutes = 42}) => Note(
  id: id,
  title: id,
  titleSource: NoteTitleSource.ai,
  status: NoteStatus.ready,
  source: NoteSource.recording,
  durationMs: minutes * 60000,
  createdAt: local.toUtc().toIso8601String(),
  updatedAt: local.toUtc().toIso8601String(),
);

void main() {
  // Local times: grouping is by the phone's calendar day.
  final now = DateTime(2026, 3, 9, 0, 30);

  group('noteDayLabel', () {
    test('splits at local midnight, not UTC midnight', () {
      expect(noteDayLabel(DateTime(2026, 3, 9, 0, 1), now), 'Today');
      expect(noteDayLabel(DateTime(2026, 3, 8, 23, 59), now), 'Yesterday');
      expect(
        noteDayLabel(DateTime(2026, 3, 9, 0, 1).toUtc(), now),
        'Today',
        reason: 'UTC times are converted to local first',
      );
    });

    test('older days show the weekday and date, other years the year', () {
      expect(noteDayLabel(DateTime(2026, 3, 7, 12), now), 'Sat, Mar 7');
      expect(noteDayLabel(DateTime(2025, 12, 31, 12), now), 'Dec 31, 2025');
    });

    test('counts calendar days across a daylight-saving change', () {
      // 23- and 25-hour days must not shift Yesterday.
      final afterChange = DateTime(2026, 3, 9, 12);
      expect(
        noteDayLabel(DateTime(2026, 3, 8, 0, 30), afterChange),
        'Yesterday',
      );
      expect(
        noteDayLabel(DateTime(2026, 3, 7, 23, 30), afterChange),
        'Sat, Mar 7',
      );
    });
  });

  test(
    'groupNotesByDay puts one header before each day and marks card edges',
    () {
      final state = NotesState(
        noteById: {
          'a': _note('a', DateTime(2026, 3, 9, 0, 10)),
          'b': _note('b', DateTime(2026, 3, 8, 23, 50)),
          'c': _note('c', DateTime(2026, 3, 8, 9, 0)),
          'd': _note('d', DateTime(2026, 3, 2, 9, 0)),
        },
        serverNoteIds: const ['a', 'b', 'c', 'd'],
      );
      final entries = groupNotesByDay(buildNoteList(state), now);
      final shape = entries.map(
        (e) => switch (e) {
          NoteDayHeader(:final label) => '# $label',
          NoteRow(:final view, :final isFirstInDay, :final isLastInDay) =>
            '${view.id}${isFirstInDay ? '^' : ''}${isLastInDay ? r'$' : ''}',
        },
      );
      expect(shape, [
        '# Today',
        r'a^$',
        '# Yesterday',
        'b^',
        r'c$',
        '# Mon, Mar 2',
        r'd^$',
      ]);
    },
  );

  test('groupNotesByDay stays fast for many hundreds of notes', () {
    final notes = {
      for (var i = 0; i < 2000; i++)
        'n$i': _note('n$i', now.subtract(Duration(hours: i * 3))),
    };
    final state = NotesState(
      noteById: notes,
      serverNoteIds: notes.keys.toList(),
    );
    final watch = Stopwatch()..start();
    final entries = groupNotesByDay(buildNoteList(state), now);
    expect(entries.whereType<NoteRow>(), hasLength(2000));
    // Generous bound: catches quadratic work, not machine load.
    expect(watch.elapsedMilliseconds, lessThan(2000));
  });

  test('formatNoteLength reads naturally', () {
    expect(formatNoteLength(20000), 'Under a minute');
    expect(formatNoteLength(45 * 60000), '45 min');
    expect(formatNoteLength(60 * 60000), '1 h');
    expect(formatNoteLength(125 * 60000), '2 h 5 min');
  });

  test('noteStatusLine shows length and the state that needs attention', () {
    NoteView view(
      LocalNotePhase phase, {
      NoteSyncStatus? sync,
      NoteSource source = NoteSource.recording,
    }) {
      final local = LocalNote(
        id: 'x',
        source: source,
        title: 'x',
        createdAt: now.toUtc().toIso8601String(),
        phase: phase,
        segments: const [
          LocalNoteSegment(id: 's', fileName: 's', durationMs: 1500000),
        ],
      );
      return buildNoteView(
        NotesState(localNoteById: {'x': local}, syncById: {'x': ?sync}),
        'x',
      )!;
    }

    expect(
      noteStatusLine(
        view(
          LocalNotePhase.uploading,
          sync: const NoteSyncStatus(uploadProgress: 0.4),
        ),
      ),
      '25 min · Uploading 40%',
    );
    expect(
      noteStatusLine(
        view(
          LocalNotePhase.pendingUpload,
          sync: const NoteSyncStatus(isWaitingForConnection: true),
        ),
      ),
      '25 min · Waiting for connection',
    );
    expect(
      noteStatusLine(
        view(
          LocalNotePhase.pendingUpload,
          sync: const NoteSyncStatus(isQueued: true),
        ),
      ),
      '25 min · Queued',
    );
    expect(
      noteStatusLine(view(LocalNotePhase.processing)),
      '25 min · Writing notes',
    );
    expect(
      noteStatusLine(view(LocalNotePhase.failed)),
      "25 min · Couldn't process",
    );
    expect(
      noteStatusLine(
        view(LocalNotePhase.uploading, source: NoteSource.imported),
      ),
      'Imported transcript · Uploading',
    );
  });

  group('askUnavailableReason', () {
    final ready = _note('r', DateTime(2026, 3, 8, 9));

    test('is null when Ask can run', () {
      final state = NotesState(
        noteById: {'r': ready},
        serverNoteIds: const ['r'],
      );
      expect(askUnavailableReason(state, noteId: 'r', now: now), isNull);
      expect(askUnavailableReason(state, now: now), isNull);
    });

    test('explains a note without a transcript yet', () {
      final state = NotesState(
        localNoteById: {
          'l': LocalNote(
            id: 'l',
            title: 'l',
            createdAt: now.toUtc().toIso8601String(),
            phase: LocalNotePhase.recording,
          ),
        },
      );
      expect(
        askUnavailableReason(state, noteId: 'l', now: now),
        'Ask works once this meeting is processed.',
      );
    });

    test('offline and the daily limit apply to every Ask box', () {
      expect(
        askUnavailableReason(const NotesState(isOffline: true), now: now),
        "You're offline. Ask needs a connection.",
      );
      final limited = NotesState(
        askAvailableAt: now
            .add(const Duration(hours: 2))
            .toUtc()
            .toIso8601String(),
      );
      expect(
        askUnavailableReason(limited, now: now),
        startsWith("You've reached today's Ask limit. It resets at "),
      );
      final expired = NotesState(
        askAvailableAt: now
            .subtract(const Duration(minutes: 1))
            .toUtc()
            .toIso8601String(),
      );
      expect(askUnavailableReason(expired, now: now), isNull);
    });
  });
}
