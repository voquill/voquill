import 'package:app/api/notes_api.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/notes_state.dart';
import 'package:intl/intl.dart';

enum NoteDisplayState {
  recording,
  paused,
  waitingForConnection,

  /// The plan's limit of notes processing at once is reached; this one goes
  /// when another finishes.
  queued,
  uploading,
  processing,
  failed,
  ready,
  draft;

  bool get isCapturing => this == recording || this == paused;
  bool get isBusy =>
      this == waitingForConnection ||
      this == queued ||
      this == uploading ||
      this == processing;
}

/// One note as the UI sees it: the local copy (if any) merged over the
/// server copy, with unsynced edits applied.
class NoteView {
  final String id;
  final String title;
  final String personalNotes;
  final DateTime createdAt;
  final NoteDisplayState state;
  final double? uploadProgress;
  final LocalNote? local;
  final Note? server;

  const NoteView({
    required this.id,
    required this.title,
    required this.personalNotes,
    required this.createdAt,
    required this.state,
    this.uploadProgress,
    this.local,
    this.server,
  });

  int durationMs(DateTime now) =>
      local?.elapsedMs(now) ?? server?.durationMs ?? 0;

  NoteError? get error => local?.error ?? server?.error;

  /// The note is ready but part of its audio could not be transcribed; that
  /// audio is still on the device.
  NoteError? get failedSegmentError =>
      local?.phase == LocalNotePhase.ready && local!.segments.isNotEmpty
      ? local!.error
      : null;

  bool get canAsk => server?.hasTranscript ?? false;
}

NoteDisplayState _localDisplayState(LocalNote local, NoteSyncStatus? sync) {
  switch (local.phase) {
    case LocalNotePhase.recording:
      return NoteDisplayState.recording;
    case LocalNotePhase.paused:
      return NoteDisplayState.paused;
    case LocalNotePhase.pendingUpload:
    case LocalNotePhase.uploading:
    case LocalNotePhase.processing:
      if (sync?.isQueued == true) return NoteDisplayState.queued;
      if (sync?.isWaitingForConnection == true) {
        return NoteDisplayState.waitingForConnection;
      }
      return local.phase == LocalNotePhase.processing
          ? NoteDisplayState.processing
          : NoteDisplayState.uploading;
    case LocalNotePhase.ready:
      return NoteDisplayState.ready;
    case LocalNotePhase.failed:
      return NoteDisplayState.failed;
  }
}

NoteDisplayState _serverDisplayState(Note note) {
  switch (note.status) {
    case NoteStatus.draft:
      return NoteDisplayState.draft;
    case NoteStatus.processing:
      return NoteDisplayState.processing;
    case NoteStatus.ready:
      return NoteDisplayState.ready;
    case NoteStatus.failed:
      return NoteDisplayState.failed;
  }
}

NoteView? buildNoteView(NotesState state, String id) {
  if (state.pendingDeleteIds.contains(id)) return null;
  final local = state.localNoteById[id];
  final server = state.noteById[id];
  if (local == null && server == null) return null;
  final edit = state.pendingEditById[id];
  final sync = state.syncById[id];

  return NoteView(
    id: id,
    title: edit?.title ?? local?.title ?? server!.title,
    personalNotes:
        edit?.personalNotes ?? local?.personalNotes ?? server!.personalNotes,
    createdAt: (local?.createdAtDate ?? server!.createdAtDate).toLocal(),
    state: local != null
        ? _localDisplayState(local, sync)
        : _serverDisplayState(server!),
    uploadProgress: local != null ? sync?.uploadProgress : null,
    local: local,
    server: server,
  );
}

/// Local and server notes as one list: the capturing note pinned on top,
/// then newest first. [query] filters titles locally.
List<NoteView> buildNoteList(NotesState state, {String query = ''}) {
  final ids = <String>{...state.localNoteById.keys, ...state.serverNoteIds};
  final needle = query.trim().toLowerCase();
  final views = ids
      .map((id) => buildNoteView(state, id))
      .whereType<NoteView>()
      .where((v) => needle.isEmpty || v.title.toLowerCase().contains(needle))
      .toList();

  views.sort((a, b) {
    final pinned =
        (b.state.isCapturing ? 1 : 0) - (a.state.isCapturing ? 1 : 0);
    if (pinned != 0) return pinned;
    return b.createdAt.compareTo(a.createdAt);
  });
  return views;
}

String defaultNoteTitle(DateTime createdAt) =>
    'Meeting · ${DateFormat('MMM d, h:mm a').format(createdAt)}';

String formatNoteDuration(int ms) {
  final total = ms ~/ 1000;
  final hours = total ~/ 3600;
  final minutes = (total % 3600) ~/ 60;
  final seconds = total % 60;
  final mm = minutes.toString().padLeft(hours > 0 ? 2 : 1, '0');
  final ss = seconds.toString().padLeft(2, '0');
  return hours > 0 ? '$hours:$mm:$ss' : '$mm:$ss';
}

const _genericNoteError = 'Something went wrong while processing this note.';

/// User-facing text per server error code (server messages are for logs).
const _noteErrorMessages = {
  'word_quota_exceeded':
      "You've used all of your free words for now. Upgrade to Pro to process this meeting.",
  'audio_quota_exceeded':
      "You've used all your meeting audio for the last 30 days. Upgrade, or wait until older recordings stop counting.",
  'member_not_found':
      'Your account is still being set up. Try again in a moment.',
  'transcription_failed': 'The recording could not be transcribed right now.',
  'unsupported_audio': 'Part of the recording could not be read.',
  'audio_missing':
      'The server no longer has this audio. Retry to upload it again.',
  'generation_failed': 'The notes could not be written right now.',
  'no_audio': 'No audio was recorded for this note.',
  'note_not_found': 'This note was deleted on another device.',
  'note_exists': 'This transcript could not be imported.',
  'segment_too_large': 'This recording is too large for your plan.',
  'segment_too_long': 'A single recording can be at most 4 hours long.',
  'note_too_long': 'A note can contain at most 8 hours of audio.',
  'too_many_segments': 'This note has too many recordings. Start a new note.',
  'client_error': 'Something went wrong on this device.',
};

/// Plain-language explanation for a failed note or segment.
String describeNoteError(NoteError? error) =>
    _noteErrorMessages[error?.code] ?? _genericNoteError;

/// Plain-language text for a failed request the user just made.
String describeApiError(NotesApiException e) {
  if (e.isNetwork) return "You're offline. Try again when you're connected.";
  if (e.code == 'regenerate_cooldown') {
    final seconds = e.retryAfterSeconds;
    return seconds == null
        ? 'The notes were just regenerated. Try again in a few minutes.'
        : 'The notes were just regenerated. Try again in ${(seconds / 60).ceil()} min.';
  }
  return describeNoteError(e.toNoteError());
}

bool isQuotaError(NoteError? error) =>
    error?.code == 'word_quota_exceeded' ||
    error?.code == 'audio_quota_exceeded';

class TranscriptLine {
  final String label;
  final String text;
  final bool isFailed;

  const TranscriptLine({
    required this.label,
    required this.text,
    this.isFailed = false,
  });
}

/// The note transcript in segment order. Utterance times are relative to
/// their segment, so each segment is offset by the audio before it; speaker
/// labels are per segment, as the server assigns them.
List<TranscriptLine> transcriptLines(List<NoteSegment> segments) {
  final sorted = [...segments]..sort((a, b) => a.index.compareTo(b.index));
  final lines = <TranscriptLine>[];
  var offsetMs = 0;
  for (final segment in sorted) {
    final transcript = segment.transcript;
    if (segment.status == NoteSegmentStatus.failed) {
      lines.add(
        const TranscriptLine(
          label: '',
          text: "This part of the recording couldn't be transcribed.",
          isFailed: true,
        ),
      );
    } else if (transcript != null && transcript.utterances.isEmpty) {
      if (transcript.text.trim().isNotEmpty) {
        lines.add(TranscriptLine(label: '', text: transcript.text.trim()));
      }
    } else if (transcript != null) {
      for (final utterance in transcript.utterances) {
        final speaker = utterance.speaker;
        final time = formatNoteDuration(offsetMs + utterance.startMs);
        lines.add(
          TranscriptLine(
            label: speaker == null ? time : 'Speaker ${speaker + 1} · $time',
            text: utterance.text,
          ),
        );
      }
    }
    offsetMs += segment.durationMs;
  }
  return lines;
}

String transcriptText(List<NoteSegment> segments) => transcriptLines(segments)
    .where((line) => !line.isFailed)
    .map(
      (line) => line.label.isEmpty ? line.text : '${line.label}\n${line.text}',
    )
    .join('\n\n');
