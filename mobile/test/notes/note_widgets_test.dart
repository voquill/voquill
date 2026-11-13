import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/app_state.dart';
import 'package:app/state/notes_state.dart';
import 'package:app/store/store.dart';
import 'package:app/widgets/notes/active_note_banner.dart';
import 'package:app/widgets/notes/note_page.dart';
import 'package:app/widgets/notes/notes_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'test_theme.dart';

const _recording = LocalNote(
  id: 'rec',
  title: 'Standup',
  createdAt: '2026-01-02T10:00:00.000Z',
  phase: LocalNotePhase.paused,
  segments: [LocalNoteSegment(id: 's', fileName: 's.aac', durationMs: 65000)],
);

const _ready = Note(
  id: 'ready',
  title: 'Roadmap review',
  titleSource: NoteTitleSource.ai,
  status: NoteStatus.ready,
  source: NoteSource.recording,
  personalNotes: 'budget?',
  generatedNotes: '## Decisions\n- Ship it',
  durationMs: 120000,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:00:00.000Z',
  segments: [
    NoteSegment(
      id: 'a',
      index: 0,
      kind: NoteSegmentKind.audio,
      status: NoteSegmentStatus.transcribed,
      durationMs: 60000,
      createdAt: '2026-01-01T10:00:00.000Z',
      transcript: NoteTranscript(
        text: 'Hello',
        utterances: [
          NoteUtterance(startMs: 0, endMs: 900, speaker: 0, text: 'Hello team'),
        ],
      ),
    ),
    NoteSegment(
      id: 'b',
      index: 1,
      kind: NoteSegmentKind.audio,
      status: NoteSegmentStatus.failed,
      durationMs: 60000,
      createdAt: '2026-01-01T10:00:00.000Z',
    ),
  ],
);

/// One test: StoreScope disposes the global store when it unmounts, so the
/// scenarios share a single scope and swap the page under it.
void main() {
  testWidgets('notes screens render each state', (tester) async {
    setAppState(
      const AppState(
        notes: NotesState(
          isInitialized: true,
          recorderNoteId: 'rec',
          noteById: {'ready': _ready},
          serverNoteIds: ['ready'],
          localNoteById: {'rec': _recording},
        ),
      ),
    );

    Future<void> show(Widget child) async {
      await tester.pumpWidget(StoreScope(child: MaterialApp(theme: testTheme(), home: child)));
      await tester.pump();
    }

    await show(const NotesPage());
    expect(find.text('Standup'), findsOneWidget);
    expect(find.text('Recording now'), findsOneWidget);
    expect(find.text('Paused · '), findsOneWidget);
    expect(find.text('Roadmap review'), findsOneWidget);
    expect(find.byTooltip('Back to the meeting'), findsOneWidget);
    expect(find.text('Ask your notes'), findsOneWidget);
    expect(
      tester.getTopLeft(find.text('Standup')).dy,
      lessThan(tester.getTopLeft(find.text('Roadmap review')).dy),
    );

    await show(const NotePage(noteId: 'rec'));
    expect(find.text('1:05'), findsOneWidget);
    expect(find.byTooltip('Resume recording'), findsOneWidget);
    expect(find.byTooltip('Stop and write notes'), findsOneWidget);
    expect(find.text('My notes'), findsOneWidget);
    expect(find.text('Ask works once this meeting is processed.'), findsOneWidget);

    await show(const NotePage(noteId: 'ready'));
    expect(find.text('Decisions'), findsOneWidget);
    expect(find.text('Copy notes'), findsOneWidget);
    await tester.tap(find.text('Transcript'));
    await tester.pumpAndSettle();
    expect(find.text('Copy transcript'), findsOneWidget);
    expect(find.text('Speaker 1 · 0:00'), findsOneWidget);
    expect(find.text('Hello team'), findsOneWidget);
    expect(find.textContaining("couldn't be transcribed"), findsOneWidget);

    await show(const Scaffold(bottomNavigationBar: ActiveNoteBanner()));
    expect(find.textContaining('Notes paused'), findsOneWidget);
  });
}
