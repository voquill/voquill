import 'package:app/model/common_model.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:draft/draft.dart';
import 'package:equatable/equatable.dart';

part 'notes_state.draft.dart';

@draft
class NoteSyncStatus with EquatableMixin {
  final double? uploadProgress;
  final bool isWaitingForConnection;

  /// The server is at the plan's limit of notes processing (or uploads
  /// pending); this note goes next.
  final bool isQueued;

  const NoteSyncStatus({
    this.uploadProgress,
    this.isWaitingForConnection = false,
    this.isQueued = false,
  });

  @override
  List<Object?> get props => [uploadProgress, isWaitingForConnection, isQueued];
}

@draft
class NotesState with EquatableMixin {
  final bool isInitialized;
  final ActionStatus listStatus;
  final ActionStatus loadMoreStatus;

  /// A start/pause/resume/stop is in flight; recording controls wait.
  final bool isRecorderBusy;

  /// Latest known server copy of each note.
  final Map<String, Note> noteById;

  /// Server list order (newest first) across loaded pages.
  final List<String> serverNoteIds;
  final String? nextCursor;

  final Map<String, LocalNote> localNoteById;
  final Map<String, NoteEdit> pendingEditById;
  final List<String> pendingDeleteIds;

  /// Runtime-only sync progress; never persisted.
  final Map<String, NoteSyncStatus> syncById;

  const NotesState({
    this.isInitialized = false,
    this.listStatus = ActionStatus.idle,
    this.loadMoreStatus = ActionStatus.idle,
    this.isRecorderBusy = false,
    this.noteById = const {},
    this.serverNoteIds = const [],
    this.nextCursor,
    this.localNoteById = const {},
    this.pendingEditById = const {},
    this.pendingDeleteIds = const [],
    this.syncById = const {},
  });

  LocalNote? get capturingNote =>
      localNoteById.values.where((n) => n.isCapturing).firstOrNull;

  @override
  List<Object?> get props => [
    isInitialized,
    listStatus,
    loadMoreStatus,
    isRecorderBusy,
    noteById,
    serverNoteIds,
    nextCursor,
    localNoteById,
    pendingEditById,
    pendingDeleteIds,
    syncById,
  ];
}
