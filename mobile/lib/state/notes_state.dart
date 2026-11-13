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

  const NoteSyncStatus({
    this.uploadProgress,
    this.isWaitingForConnection = false,
  });

  @override
  List<Object?> get props => [uploadProgress, isWaitingForConnection];
}

@draft
class NotesState with EquatableMixin {
  final bool isInitialized;
  final ActionStatus listStatus;

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
    noteById,
    serverNoteIds,
    nextCursor,
    localNoteById,
    pendingEditById,
    pendingDeleteIds,
    syncById,
  ];
}
