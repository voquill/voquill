import 'package:app/model/note_model.dart';
import 'package:draft/draft.dart';
import 'package:equatable/equatable.dart';
import 'package:json_annotation/json_annotation.dart';

part 'local_note_model.g.dart';
part 'local_note_model.draft.dart';

/// Client lifecycle of a note that still has work or files on this device.
/// Transitions live in `note_lifecycle_utils.dart`.
enum LocalNotePhase {
  recording,
  paused,
  pendingUpload,
  uploading,
  processing,
  ready,
  failed,
}

@JsonSerializable()
@draft
class LocalNoteSegment with EquatableMixin {
  final String id;

  /// File name inside the note's directory; never an absolute path because
  /// the iOS container path changes between app updates.
  final String fileName;

  /// Position in the note; null when a resumed note's server segments were
  /// unknown at recording time (the server then appends it).
  final int? index;
  final int durationMs;

  /// The native recorder may still be appending to this file.
  final bool isOpen;
  final String? uploadUrl;
  final bool isUploaded;

  const LocalNoteSegment({
    required this.id,
    required this.fileName,
    this.index,
    this.durationMs = 0,
    this.isOpen = false,
    this.uploadUrl,
    this.isUploaded = false,
  });

  factory LocalNoteSegment.fromJson(Map<String, dynamic> json) =>
      _$LocalNoteSegmentFromJson(json);
  Map<String, dynamic> toJson() => _$LocalNoteSegmentToJson(this);

  @override
  List<Object?> get props => [
    id,
    fileName,
    index,
    durationMs,
    isOpen,
    uploadUrl,
    isUploaded,
  ];
}

@JsonSerializable(explicitToJson: true)
@draft
class LocalNote with EquatableMixin {
  final String id;
  final NoteSource source;
  final String title;
  final NoteTitleSource titleSource;
  final String personalNotes;
  final String createdAt;
  final LocalNotePhase phase;
  final List<LocalNoteSegment> segments;

  /// Audio the server already holds for this note (a resumed ready note).
  final int priorDurationMs;

  /// The server is known to have this note, so PATCH and DELETE apply.
  final bool existsOnServer;

  /// Wall-clock start of the current recording run; null unless recording.
  final String? recordingStartedAt;
  final NoteError? error;

  const LocalNote({
    required this.id,
    this.source = NoteSource.recording,
    required this.title,
    this.titleSource = NoteTitleSource.defaultTitle,
    this.personalNotes = '',
    required this.createdAt,
    required this.phase,
    this.segments = const [],
    this.priorDurationMs = 0,
    this.existsOnServer = false,
    this.recordingStartedAt,
    this.error,
  });

  factory LocalNote.fromJson(Map<String, dynamic> json) =>
      _$LocalNoteFromJson(json);
  Map<String, dynamic> toJson() => _$LocalNoteToJson(this);

  DateTime get createdAtDate => DateTime.parse(createdAt);

  bool get isCapturing =>
      phase == LocalNotePhase.recording || phase == LocalNotePhase.paused;

  LocalNoteSegment? get openSegment =>
      segments.where((s) => s.isOpen).firstOrNull;

  int elapsedMs(DateTime now) {
    final recorded = segments.fold<int>(0, (sum, s) => sum + s.durationMs);
    final startedAt = recordingStartedAt;
    final running = startedAt == null
        ? 0
        : now.difference(DateTime.parse(startedAt)).inMilliseconds;
    return priorDurationMs + recorded + (running < 0 ? 0 : running);
  }

  @override
  List<Object?> get props => [
    id,
    source,
    title,
    titleSource,
    personalNotes,
    createdAt,
    phase,
    segments,
    priorDurationMs,
    existsOnServer,
    recordingStartedAt,
    error,
  ];
}

/// An unsynced title / My notes change waiting for `PATCH`.
@JsonSerializable()
@draft
class NoteEdit with EquatableMixin {
  final String? title;
  final String? personalNotes;

  const NoteEdit({this.title, this.personalNotes});

  factory NoteEdit.fromJson(Map<String, dynamic> json) =>
      _$NoteEditFromJson(json);
  Map<String, dynamic> toJson() => _$NoteEditToJson(this);

  @override
  List<Object?> get props => [title, personalNotes];
}

/// Everything about notes that must survive an app restart.
@JsonSerializable(explicitToJson: true)
class LocalNotesSnapshot with EquatableMixin {
  final List<LocalNote> localNotes;
  final Map<String, NoteEdit> pendingEdits;
  final List<String> pendingDeleteIds;

  const LocalNotesSnapshot({
    this.localNotes = const [],
    this.pendingEdits = const {},
    this.pendingDeleteIds = const [],
  });

  factory LocalNotesSnapshot.fromJson(Map<String, dynamic> json) =>
      _$LocalNotesSnapshotFromJson(json);
  Map<String, dynamic> toJson() => _$LocalNotesSnapshotToJson(this);

  @override
  List<Object?> get props => [localNotes, pendingEdits, pendingDeleteIds];
}
