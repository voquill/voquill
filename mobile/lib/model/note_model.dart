import 'package:equatable/equatable.dart';
import 'package:json_annotation/json_annotation.dart';

part 'note_model.g.dart';

enum NoteStatus {
  @JsonValue('draft')
  draft,
  @JsonValue('processing')
  processing,
  @JsonValue('ready')
  ready,
  @JsonValue('failed')
  failed,
}

enum NoteTitleSource {
  @JsonValue('default')
  defaultTitle,
  @JsonValue('ai')
  ai,
  @JsonValue('user')
  user,
}

enum NoteSource {
  @JsonValue('recording')
  recording,
  @JsonValue('import')
  imported,
}

enum NoteSegmentKind {
  @JsonValue('audio')
  audio,
  @JsonValue('import')
  imported,
}

enum NoteSegmentStatus {
  @JsonValue('uploading')
  uploading,
  @JsonValue('uploaded')
  uploaded,
  @JsonValue('transcribed')
  transcribed,
  @JsonValue('failed')
  failed,
}

@JsonSerializable()
class NoteError with EquatableMixin {
  final String code;
  final String message;

  const NoteError({required this.code, required this.message});

  factory NoteError.fromJson(Map<String, dynamic> json) =>
      _$NoteErrorFromJson(json);
  Map<String, dynamic> toJson() => _$NoteErrorToJson(this);

  @override
  List<Object?> get props => [code, message];
}

@JsonSerializable()
class NoteUtterance with EquatableMixin {
  final int startMs;
  final int endMs;
  final int? speaker;
  final String text;

  const NoteUtterance({
    required this.startMs,
    required this.endMs,
    this.speaker,
    required this.text,
  });

  factory NoteUtterance.fromJson(Map<String, dynamic> json) =>
      _$NoteUtteranceFromJson(json);
  Map<String, dynamic> toJson() => _$NoteUtteranceToJson(this);

  @override
  List<Object?> get props => [startMs, endMs, speaker, text];
}

@JsonSerializable(explicitToJson: true)
class NoteTranscript with EquatableMixin {
  final String text;
  final List<NoteUtterance> utterances;

  const NoteTranscript({required this.text, this.utterances = const []});

  factory NoteTranscript.fromJson(Map<String, dynamic> json) =>
      _$NoteTranscriptFromJson(json);
  Map<String, dynamic> toJson() => _$NoteTranscriptToJson(this);

  @override
  List<Object?> get props => [text, utterances];
}

@JsonSerializable(explicitToJson: true)
class NoteSegment with EquatableMixin {
  final String id;
  final int index;
  @JsonKey(unknownEnumValue: NoteSegmentKind.audio)
  final NoteSegmentKind kind;
  @JsonKey(unknownEnumValue: NoteSegmentStatus.uploaded)
  final NoteSegmentStatus status;
  final NoteError? error;
  final int durationMs;
  final String createdAt;
  final NoteTranscript? transcript;

  const NoteSegment({
    required this.id,
    required this.index,
    required this.kind,
    required this.status,
    this.error,
    required this.durationMs,
    required this.createdAt,
    this.transcript,
  });

  factory NoteSegment.fromJson(Map<String, dynamic> json) =>
      _$NoteSegmentFromJson(json);
  Map<String, dynamic> toJson() => _$NoteSegmentToJson(this);

  @override
  List<Object?> get props => [
    id,
    index,
    kind,
    status,
    error,
    durationMs,
    createdAt,
    transcript,
  ];
}

@JsonSerializable(explicitToJson: true)
class Note with EquatableMixin {
  final String id;
  final String title;
  @JsonKey(unknownEnumValue: NoteTitleSource.ai)
  final NoteTitleSource titleSource;
  @JsonKey(unknownEnumValue: NoteStatus.processing)
  final NoteStatus status;
  final NoteError? error;
  @JsonKey(unknownEnumValue: NoteSource.recording)
  final NoteSource source;
  final String personalNotes;
  final String? generatedNotes;
  final int durationMs;
  final String createdAt;
  final String updatedAt;

  /// Only present on the single-note endpoint.
  final List<NoteSegment>? segments;

  const Note({
    required this.id,
    required this.title,
    required this.titleSource,
    required this.status,
    this.error,
    required this.source,
    this.personalNotes = '',
    this.generatedNotes,
    required this.durationMs,
    required this.createdAt,
    required this.updatedAt,
    this.segments,
  });

  factory Note.fromJson(Map<String, dynamic> json) => _$NoteFromJson(json);
  Map<String, dynamic> toJson() => _$NoteToJson(this);

  DateTime get createdAtDate => DateTime.parse(createdAt);

  bool get hasTranscript =>
      segments?.any((s) => s.transcript != null) ?? status == NoteStatus.ready;

  Note withoutSegments() => copyWithSegments(null);

  Note copyWithSegments(List<NoteSegment>? segments) => Note(
    id: id,
    title: title,
    titleSource: titleSource,
    status: status,
    error: error,
    source: source,
    personalNotes: personalNotes,
    generatedNotes: generatedNotes,
    durationMs: durationMs,
    createdAt: createdAt,
    updatedAt: updatedAt,
    segments: segments,
  );

  @override
  List<Object?> get props => [
    id,
    title,
    titleSource,
    status,
    error,
    source,
    personalNotes,
    generatedNotes,
    durationMs,
    createdAt,
    updatedAt,
    segments,
  ];
}

@JsonSerializable(explicitToJson: true)
class NoteListPage with EquatableMixin {
  final List<Note> notes;
  final String? nextCursor;

  const NoteListPage({required this.notes, this.nextCursor});

  factory NoteListPage.fromJson(Map<String, dynamic> json) =>
      _$NoteListPageFromJson(json);
  Map<String, dynamic> toJson() => _$NoteListPageToJson(this);

  @override
  List<Object?> get props => [notes, nextCursor];
}

@JsonSerializable(explicitToJson: true)
class NoteSearchResult with EquatableMixin {
  final Note note;
  final String snippet;
  final double score;

  const NoteSearchResult({
    required this.note,
    required this.snippet,
    required this.score,
  });

  factory NoteSearchResult.fromJson(Map<String, dynamic> json) =>
      _$NoteSearchResultFromJson(json);
  Map<String, dynamic> toJson() => _$NoteSearchResultToJson(this);

  @override
  List<Object?> get props => [note, snippet, score];
}

@JsonSerializable()
class NoteAskSource with EquatableMixin {
  final String noteId;
  final String title;

  const NoteAskSource({required this.noteId, required this.title});

  factory NoteAskSource.fromJson(Map<String, dynamic> json) =>
      _$NoteAskSourceFromJson(json);
  Map<String, dynamic> toJson() => _$NoteAskSourceToJson(this);

  @override
  List<Object?> get props => [noteId, title];
}
