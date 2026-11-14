import 'package:app/model/common_model.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/app_state.dart';
import 'package:app/state/notes_state.dart';
import 'package:app/store/store.dart';
import 'package:app/widgets/notes/active_note_banner.dart';
import 'package:app/widgets/notes/ask_dock.dart';
import 'package:app/widgets/notes/ask_thread.dart';
import 'package:app/widgets/notes/note_page.dart';
import 'package:app/widgets/notes/notes_page.dart';
import 'package:app/widgets/notes/sign_out_meeting_dialog.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';

final _now = DateTime.now();
String _iso(DateTime local) => local.toUtc().toIso8601String();
DateTime _today(int hour, int minute) =>
    DateTime(_now.year, _now.month, _now.day, hour, minute);

Note _note(
  String id,
  String title,
  DateTime createdAt, {
  NoteStatus status = NoteStatus.ready,
  int minutes = 42,
  String? generatedNotes = _generated,
  List<NoteSegment>? segments,
  NoteError? error,
  NoteSource source = NoteSource.recording,
}) => Note(
  id: id,
  title: title,
  titleSource: NoteTitleSource.ai,
  status: status,
  error: error,
  source: source,
  personalNotes: 'Ask about the hiring plan\nBudget for Q3?',
  generatedNotes: status == NoteStatus.ready ? generatedNotes : null,
  durationMs: minutes * 60000,
  createdAt: _iso(createdAt),
  updatedAt: _iso(createdAt),
  segments: segments,
);

const _generated = '''
## Summary
The team agreed to ship the new onboarding flow to beta testers by Friday and keep the scope to the first three screens.

## Decisions
- Test with a small beta group rather than releasing to everyone.
- Team invites and billing are out of scope for now.

## Action items
- [ ] **Mina**: collect feedback from five beta testers
- [ ] **Alex**: share the beta build link [1]
- [x] Confirm Monday review time

| Owner | Task | Due |
|-------|------|-----|
| Mina | Collect feedback | Thu |
| Alex | Beta build | Fri |
''';

List<NoteSegment> _segments({
  bool withFailedPart = false,
  int utterances = 12,
}) => [
  NoteSegment(
    id: 'seg-a',
    index: 0,
    kind: NoteSegmentKind.audio,
    status: NoteSegmentStatus.transcribed,
    durationMs: 1800000,
    createdAt: _iso(_now),
    transcript: NoteTranscript(
      text: 'x',
      utterances: [
        for (var i = 0; i < utterances; i++)
          NoteUtterance(
            startMs: i * 41000,
            endMs: i * 41000 + 9000,
            speaker: i % 3,
            text: [
              "Okay, let's get started. The main thing today is the new onboarding flow.",
              'Right, the beta testers get it over the weekend, so we need it by Friday.',
              'Can we limit it to the first three screens? Invites and billing are not ready.',
            ][i % 3],
          ),
      ],
    ),
  ),
  if (withFailedPart)
    NoteSegment(
      id: 'seg-b',
      index: 1,
      kind: NoteSegmentKind.audio,
      status: NoteSegmentStatus.failed,
      error: const NoteError(code: 'unsupported_audio', message: ''),
      durationMs: 600000,
      createdAt: _iso(_now),
    ),
];

LocalNote _local(
  String id,
  String title,
  DateTime createdAt,
  LocalNotePhase phase, {
  int seconds = 1460,
  String? startedAt,
  NoteError? error,
  NoteSource source = NoteSource.recording,
}) => LocalNote(
  id: id,
  source: source,
  title: title,
  createdAt: _iso(createdAt),
  phase: phase,
  personalNotes: phase == LocalNotePhase.recording
      ? 'Beta testers get it Friday'
      : '',
  recordingStartedAt: startedAt,
  error: error,
  segments: [
    LocalNoteSegment(
      id: 's-$id',
      fileName: 's.aac',
      durationMs: seconds * 1000,
      isOpen: phase == LocalNotePhase.recording,
    ),
  ],
);

NotesState _listState({bool recording = false}) {
  final notes = <Note>[
    _note('n1', 'Onboarding redesign review', _today(15, 30)),
    _note(
      'n2',
      'Design review with Priya and Sam about the settings layout and icon set',
      _today(9, 55),
      minutes: 67,
    ),
    _note(
      'n3',
      'Weekly sync',
      _now.subtract(const Duration(days: 1)).copyWith(hour: 14, minute: 0),
      status: NoteStatus.processing,
    ),
    _note(
      'n4',
      'Customer call: Acme',
      _now.subtract(const Duration(days: 1)).copyWith(hour: 11, minute: 20),
      status: NoteStatus.failed,
      error: const NoteError(code: 'transcription_failed', message: ''),
    ),
    _note(
      'n5',
      'Sprint planning',
      _now.subtract(const Duration(days: 3)).copyWith(hour: 8, minute: 9),
      minutes: 28,
    ),
    _note(
      'n6',
      'Imported: Launch checklist',
      _now.subtract(const Duration(days: 4)).copyWith(hour: 10, minute: 0),
      source: NoteSource.imported,
    ),
    _note(
      'n7',
      'Design review',
      _now.subtract(const Duration(days: 9)).copyWith(hour: 16, minute: 45),
      minutes: 51,
    ),
  ];
  return NotesState(
    isInitialized: true,
    listStatus: ActionStatus.success,
    noteById: {for (final n in notes) n.id: n},
    serverNoteIds: notes.map((n) => n.id).toList(),
    localNoteById: {
      'l1': _local('l1', 'Standup', _today(16, 40), LocalNotePhase.uploading),
      'l2': _local(
        'l2',
        'Interview: product designer',
        _today(13, 5),
        LocalNotePhase.pendingUpload,
      ),
      if (recording)
        'rec': _local(
          'rec',
          'Meeting · ${_now.month}/${_now.day} 5:02 PM',
          _today(17, 2),
          LocalNotePhase.recording,
          startedAt: _iso(_now),
        ),
    },
    syncById: const {
      'l1': NoteSyncStatus(uploadProgress: 0.62),
      'l2': NoteSyncStatus(isWaitingForConnection: true),
    },
  );
}

AskThread _thread({
  bool streaming = false,
  bool error = false,
  bool limit = false,
}) {
  final thread = AskThread(
    ask: ({required question, noteId, history = const []}) =>
        const Stream.empty(),
  );
  final turn = AskTurn('What did we decide about onboarding?')
    ..answer = streaming
        ? 'You agreed to test with a **small beta group** first [1].'
        : error
        ? ''
        : 'You agreed to test with a **small beta group** first, limited to the first three screens [1].\n\n- Team invites and billing are out of scope for now [1].\n- Mina collects feedback from five beta testers [2].'
    ..isStreaming = streaming
    ..sources = streaming || error
        ? const []
        : const [
            NoteAskSource(noteId: 'n1', title: 'Onboarding redesign review'),
            NoteAskSource(noteId: 'n5', title: 'Sprint planning'),
          ]
    ..error = error
        ? limit
              ? "You've reached today's limit for Ask. It resets at 12:00 AM."
              : "You're offline. Try again when you're connected."
        : null;
  thread.turns.add(turn);
  thread.isExpanded = true;
  return thread;
}

void main() {
  testWidgets('notes screens', (tester) async {
    await loadAppFonts(tester);
    void setNotes(NotesState notes) => setAppState(AppState(notes: notes));

    for (final brightness in Brightness.values) {
      Future<void> shot(
        String name,
        Widget child, {
        PhoneSize phone = iPhone15,
        Future<void> Function(WidgetTester)? interact,
      }) => capture(
        tester,
        name,
        child,
        brightness: brightness,
        phone: phone,
        interact: interact,
      );

      // List
      setNotes(_listState());
      await shot('list', const NotesPage());
      setNotes(_listState(recording: true));
      await shot('list-recording', const NotesPage());
      await shot(
        'banner-on-other-tabs',
        const Scaffold(
          body: SizedBox.expand(),
          bottomNavigationBar: ActiveNoteBanner(),
        ),
      );
      setNotes(
        const NotesState(isInitialized: true, listStatus: ActionStatus.success),
      );
      await shot('list-empty-first-run', const NotesPage());
      setNotes(
        const NotesState(
          isInitialized: false,
          listStatus: ActionStatus.loading,
        ),
      );
      await shot('list-loading', const NotesPage());
      setNotes(
        const NotesState(
          isInitialized: true,
          listStatus: ActionStatus.error,
          isOffline: true,
        ),
      );
      await shot('list-offline-empty', const NotesPage());
      setNotes(_listState().copyWithOffline());
      await shot('list-offline', const NotesPage());
      setNotes(_listState());
      await shot('list-large-text', const NotesPage(), phone: largeText);
      await shot('list-small-phone', const NotesPage(), phone: smallPhone);
      await shot(
        'list-search-titles',
        const NotesPage(),
        interact: (t) async {
          await t.enterText(find.byType(TextField).first, 'sync');
          await t.pump(const Duration(milliseconds: 100));
        },
      );
      await shot(
        'list-search-no-results',
        const NotesPage(),
        interact: (t) async {
          await t.enterText(find.byType(TextField).first, 'zebra');
          await t.pump(const Duration(milliseconds: 500));
        },
      );
      await shot(
        'list-ask-answer',
        Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              AskDock(thread: _thread()),
            ],
          ),
        ),
      );

      // Note
      setNotes(
        _noteState(
          _local(
            'rec',
            'Weekly sync with design',
            _today(17, 2),
            LocalNotePhase.recording,
            startedAt: _iso(_now),
          ),
        ),
      );
      await shot('note-recording', const NotePage(noteId: 'rec'));
      setNotes(
        _noteState(
          _local(
            'rec',
            'Weekly sync with design',
            _today(17, 2),
            LocalNotePhase.recording,
            startedAt: _iso(_now),
          ),
          isSilent: true,
        ),
      );
      await shot('note-recording-silent', const NotePage(noteId: 'rec'));
      setNotes(
        _noteState(
          _local(
            'rec',
            'Weekly sync with design',
            _today(17, 2),
            LocalNotePhase.paused,
          ),
        ),
      );
      await shot('note-paused', const NotePage(noteId: 'rec'));
      setNotes(
        _noteState(
          _local(
            'rec',
            'Recovered recording',
            _today(9, 2),
            LocalNotePhase.paused,
          ),
        ),
      );
      await shot('note-recovered', const NotePage(noteId: 'rec'));
      setNotes(
        _noteState(
          _local('up', 'Standup', _today(16, 40), LocalNotePhase.uploading),
          sync: const NoteSyncStatus(uploadProgress: 0.62),
        ),
      );
      await shot('note-uploading', const NotePage(noteId: 'up'));
      setNotes(
        _noteState(
          _local('up', 'Standup', _today(16, 40), LocalNotePhase.pendingUpload),
          sync: const NoteSyncStatus(isWaitingForConnection: true),
        ),
      );
      await shot('note-waiting-for-connection', const NotePage(noteId: 'up'));
      setNotes(
        _noteState(
          _local('up', 'Standup', _today(16, 40), LocalNotePhase.pendingUpload),
          sync: const NoteSyncStatus(isQueued: true),
        ),
      );
      await shot('note-queued', const NotePage(noteId: 'up'));
      setNotes(
        _noteState(
          _local('up', 'Standup', _today(16, 40), LocalNotePhase.processing),
        ),
      );
      await shot('note-processing', const NotePage(noteId: 'up'));
      setNotes(
        _noteState(
          _local(
            'imp',
            'Imported transcript',
            _today(16, 40),
            LocalNotePhase.uploading,
            seconds: 0,
            source: NoteSource.imported,
          ),
        ),
      );
      await shot('note-import-in-flight', const NotePage(noteId: 'imp'));
      setNotes(
        _noteState(
          _local(
            'f',
            'Standup',
            _today(16, 40),
            LocalNotePhase.failed,
            error: const NoteError(code: 'transcription_failed', message: ''),
          ),
        ),
      );
      await shot('note-failed-transcription', const NotePage(noteId: 'f'));
      setNotes(
        _noteState(
          _local(
            'f',
            'Standup',
            _today(16, 40),
            LocalNotePhase.failed,
            error: NoteError(
              code: 'audio_quota_exceeded',
              message: '',
              details: {
                'usedMs': 7200000,
                'allowanceMs': 7200000,
                'requestedMs': 1800000,
                'availableAt': _iso(_now.add(const Duration(days: 3))),
              },
            ),
          ),
        ),
      );
      await shot('note-failed-audio-limit', const NotePage(noteId: 'f'));
      setNotes(
        _noteState(
          _local(
            'f',
            'Standup',
            _today(16, 40),
            LocalNotePhase.failed,
            error: const NoteError(code: 'client_error', message: ''),
          ),
        ),
      );
      await shot('note-failed-device', const NotePage(noteId: 'f'));

      final ready = _note(
        'n1',
        'Onboarding redesign review',
        _today(15, 30),
        segments: _segments(utterances: 300),
      );
      setNotes(
        NotesState(
          isInitialized: true,
          noteById: {'n1': ready},
          serverNoteIds: const ['n1'],
        ),
      );
      await shot('note-ready-notes', const NotePage(noteId: 'n1'));
      await shot(
        'note-ready-transcript',
        const NotePage(noteId: 'n1', initialSection: NoteSection.transcript),
      );
      await shot(
        'note-ready-my-notes',
        const NotePage(noteId: 'n1', initialSection: NoteSection.myNotes),
      );
      await shot(
        'note-ready-small-phone',
        const NotePage(noteId: 'n1'),
        phone: smallPhone,
      );
      await shot(
        'note-ready-large-text',
        const NotePage(noteId: 'n1'),
        phone: largeText,
      );

      final failedPart = _note(
        'n1',
        'Onboarding redesign review',
        _today(15, 30),
        segments: _segments(withFailedPart: true),
      );
      setNotes(
        NotesState(
          isInitialized: true,
          noteById: {'n1': failedPart},
          serverNoteIds: const ['n1'],
          localNoteById: {
            'n1': LocalNote(
              id: 'n1',
              title: 'Onboarding redesign review',
              createdAt: failedPart.createdAt,
              phase: LocalNotePhase.ready,
              existsOnServer: true,
              priorDurationMs: 1800000,
              error: const NoteError(code: 'unsupported_audio', message: ''),
              segments: const [
                LocalNoteSegment(
                  id: 'seg-b',
                  fileName: 'b.aac',
                  durationMs: 600000,
                ),
              ],
            ),
          },
        ),
      );
      await shot('note-ready-failed-part', const NotePage(noteId: 'n1'));

      setNotes(
        NotesState(
          isInitialized: true,
          noteById: {'n1': ready},
          serverNoteIds: const ['n1'],
          isOffline: true,
        ),
      );
      await shot('note-ask-offline', const NotePage(noteId: 'n1'));
      setNotes(
        NotesState(
          isInitialized: true,
          noteById: {'n1': ready},
          serverNoteIds: const ['n1'],
          askAvailableAt: _iso(_now.add(const Duration(hours: 5))),
        ),
      );
      await shot('note-ask-limit', const NotePage(noteId: 'n1'));
      setNotes(
        NotesState(
          isInitialized: true,
          noteById: {'n1': ready},
          serverNoteIds: const ['n1'],
        ),
      );
      await shot(
        'ask-thread-answer',
        Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              AskDock(noteId: 'n1', thread: _thread()),
            ],
          ),
        ),
      );
      await shot(
        'ask-thread-streaming',
        Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              AskDock(noteId: 'n1', thread: _thread(streaming: true)),
            ],
          ),
        ),
      );
      await shot(
        'ask-thread-error',
        Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              AskDock(noteId: 'n1', thread: _thread(error: true)),
            ],
          ),
        ),
      );
      await shot(
        'ask-thread-collapsed',
        Scaffold(
          body: Column(
            children: [
              const Expanded(child: SizedBox()),
              AskDock(noteId: 'n1', thread: _thread()..isExpanded = false),
            ],
          ),
        ),
      );

      setNotes(
        _noteState(
          _local(
            'rec',
            'Weekly sync',
            _today(17, 2),
            LocalNotePhase.recording,
            startedAt: _iso(_now),
          ),
        ),
      );
      await shot(
        'sign-out-warning',
        Builder(
          builder: (context) => Scaffold(
            body: Center(
              child: FilledButton(
                onPressed: () => confirmSignOutDuringMeeting(context),
                child: const Text('Sign out'),
              ),
            ),
          ),
        ),
        interact: (t) async {
          await t.tap(find.text('Sign out'));
          await t.pump(const Duration(milliseconds: 400));
        },
      );
    }
  });
}

NotesState _noteState(
  LocalNote local, {
  NoteSyncStatus? sync,
  bool isSilent = false,
}) => NotesState(
  isInitialized: true,
  localNoteById: {local.id: local},
  syncById: {local.id: ?sync},
  recorderNoteId: local.isCapturing ? local.id : null,
  isRecorderSilent: isSilent,
);

extension on NotesState {
  NotesState copyWithOffline() => NotesState(
    isInitialized: isInitialized,
    listStatus: listStatus,
    noteById: noteById,
    serverNoteIds: serverNoteIds,
    localNoteById: localNoteById,
    syncById: syncById,
    isOffline: true,
  );
}
