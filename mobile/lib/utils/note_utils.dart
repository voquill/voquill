import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/notes_state.dart';
import 'package:intl/intl.dart';

enum NoteDisplayState {
  recording,
  paused,
  waitingForConnection,
  uploading,
  processing,
  failed,
  ready,
  draft;

  bool get isCapturing => this == recording || this == paused;
  bool get isBusy =>
      this == waitingForConnection || this == uploading || this == processing;
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
      return sync?.isWaitingForConnection == true
          ? NoteDisplayState.waitingForConnection
          : NoteDisplayState.uploading;
    case LocalNotePhase.processing:
      return sync?.isWaitingForConnection == true
          ? NoteDisplayState.waitingForConnection
          : NoteDisplayState.processing;
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

/// Plain-language explanation for a failed note.
String describeNoteError(NoteError? error) {
  if (error == null) return _genericNoteError;
  switch (error.code) {
    case 'word_quota_exceeded':
      return "You've used all of your free words for now. Upgrade to Pro to process this meeting.";
    case 'no_audio':
      return 'No audio was recorded for this note.';
    default:
      return error.message.isNotEmpty ? error.message : _genericNoteError;
  }
}

bool isQuotaError(NoteError? error) =>
    error?.code == 'word_quota_exceeded' ||
    error?.code == 'audio_quota_exceeded';
