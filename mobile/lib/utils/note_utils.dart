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

/// Local and server notes as one list: the live recording pinned on top,
/// then newest first. [query] filters titles locally.
List<NoteView> buildNoteList(NotesState state, {String query = ''}) {
  final ids = <String>{...state.localNoteById.keys, ...state.serverNoteIds};
  final needle = query.trim().toLowerCase();
  final views = ids
      .map((id) => buildNoteView(state, id))
      .whereType<NoteView>()
      .where((v) => needle.isEmpty || v.title.toLowerCase().contains(needle))
      .toList();

  final liveId = state.liveNote?.id;
  views.sort((a, b) {
    final pinned = (b.id == liveId ? 1 : 0) - (a.id == liveId ? 1 : 0);
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

/// "at 4:40 PM" today, "on Nov 24 at 4:40 PM" later; from an ISO time or a
/// number of seconds in [details].
String _when(
  Map<String, dynamic>? details,
  List<String> timeKeys, {
  DateTime? now,
}) {
  for (final key in timeKeys) {
    final at = DateTime.tryParse(details?[key] as String? ?? '')?.toLocal();
    if (at == null) continue;
    now ??= DateTime.now();
    final time = DateFormat.jm().format(at);
    final isToday =
        at.year == now.year && at.month == now.month && at.day == now.day;
    return isToday ? 'at $time' : 'on ${DateFormat.MMMd().format(at)} at $time';
  }
  final seconds = (details?['retryAfterSeconds'] as num?)?.toInt();
  if (seconds != null) {
    return seconds < 90 ? 'in $seconds s' : 'in ${(seconds / 60).ceil()} min';
  }
  return 'later';
}

String _hours(Object? ms) {
  final hours = ((ms as num?) ?? 0) / Duration.millisecondsPerHour;
  return hours == hours.roundToDouble()
      ? '${hours.round()} h'
      : '${hours.toStringAsFixed(1)} h';
}

String _describeAudioQuota(Map<String, dynamic>? d) {
  final allowance = _hours(d?['allowanceMs']);
  final requested = (d?['requestedMs'] as num?) ?? 0;
  if (d != null && requested > 0 && d['availableAt'] == null) {
    return 'This is longer than your $allowance of meeting audio per 30 days. '
        'Split it into shorter notes.';
  }
  final base =
      "You've used your $allowance of meeting audio for the last 30 days.";
  if (d?['availableAt'] != null) {
    return '$base This fits again ${_when(d, const ['availableAt'])}.';
  }
  if (d?['nextReleaseAt'] != null) {
    return '$base Some frees up ${_when(d, const ['nextReleaseAt'])}.';
  }
  return base;
}

/// User-facing text per server error code; server messages are for logs.
/// Limit codes say when capacity comes back, from the error's `details`.
final Map<String, String Function(Map<String, dynamic>? details)>
_noteErrorMessages = {
  'audio_quota_exceeded': _describeAudioQuota,
  'too_many_processing': (_) =>
      'Another note is being processed. This one starts as soon as it is done.',
  'regenerate_cooldown': (d) =>
      'The notes were just regenerated. Try again ${_when(d, const ['availableAt'])}.',
  'ask_limit_exceeded': (d) =>
      "You've reached today's limit for Ask. It resets ${_when(d, const ['resetsAt'])}.",
  'too_many_upload_sessions': (d) =>
      'Uploads are paused for today. They continue ${_when(d, const ['resetsAt'])}.',
  'too_many_pending_uploads': (_) =>
      'Too many recordings are waiting to upload. They continue shortly.',
  'segment_processing': (_) =>
      'This recording is being processed. Try again when it is done.',
  'note_deleted': (_) => 'This note was deleted on another device.',
  'note_not_found': (_) => 'This note was deleted on another device.',
  'member_not_found': (_) =>
      'Your account is still being set up. Try again in a moment.',
  'transcription_failed': (_) =>
      'The recording could not be transcribed right now.',
  'unsupported_audio': (_) => 'The audio could not be read.',
  'audio_missing': (_) =>
      'The server no longer has this audio. Retry to upload it again.',
  'generation_failed': (_) => 'The notes could not be written right now.',
  'no_audio': (_) => 'No audio was recorded for this note.',
  'note_exists': (_) => 'This transcript could not be imported.',
  'segment_too_large': (_) => 'This recording is too large for your plan.',
  'segment_too_long': (_) => 'A single recording can be at most 4 hours long.',
  'note_too_long': (_) => 'A note can contain at most 8 hours of audio.',
  'too_many_segments': (_) =>
      'This note has too many recordings. Start a new note.',
  'transcript_unavailable': (_) =>
      'Ask becomes available once the meeting is processed.',
  'notes_unavailable': (_) =>
      'Notes is temporarily unavailable. Try again later.',
  'client_error': (_) => 'Something went wrong on this device.',
};

/// Codes a plan upgrade resolves (offered to free members only).
const _upgradeErrorCodes = {'audio_quota_exceeded', 'ask_limit_exceeded'};

/// Plain-language explanation for a failed note, segment or request.
String describeNoteError(NoteError? error) =>
    _noteErrorMessages[error?.code]?.call(error?.details) ?? _genericNoteError;

/// Plain-language text for a failed request the user just made.
String describeApiError(NotesApiException e) => e.isNetwork
    ? "You're offline. Try again when you're connected."
    : describeNoteError(e.toNoteError());

bool isQuotaError(NoteError? error) => _upgradeErrorCodes.contains(error?.code);

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

/// One row of the grouped notes list: a day header or a note.
sealed class NoteListEntry {
  const NoteListEntry();
}

class NoteDayHeader extends NoteListEntry {
  final String label;
  const NoteDayHeader(this.label);
}

class NoteRow extends NoteListEntry {
  final NoteView view;

  /// Position inside its day's card, for rounded corners and dividers.
  final bool isFirstInDay;
  final bool isLastInDay;

  const NoteRow(
    this.view, {
    required this.isFirstInDay,
    required this.isLastInDay,
  });
}

DateTime _day(DateTime local) => DateTime(local.year, local.month, local.day);

int _dayKey(DateTime date) {
  final local = date.toLocal();
  return local.year * 10000 + local.month * 100 + local.day;
}

/// "Today", "Yesterday", "Tue, Nov 10", or "Nov 10, 2025" in another year.
/// Days are local calendar days, so a note made at 23:59 and one made at
/// 00:01 land under different headers.
String noteDayLabel(DateTime createdAt, DateTime now) {
  final day = _day(createdAt.toLocal());
  final today = _day(now.toLocal());
  final days = DateTime.utc(
    today.year,
    today.month,
    today.day,
  ).difference(DateTime.utc(day.year, day.month, day.day)).inDays;
  if (days == 0) return 'Today';
  if (days == 1) return 'Yesterday';
  if (day.year == today.year) return _weekdayDate.format(day);
  return _fullDate.format(day);
}

final _weekdayDate = DateFormat('EEE, MMM d');
final _fullDate = DateFormat('MMM d, y');
final _time = DateFormat.jm();

/// Groups [views] (already newest first) under day headers. Notes being
/// recorded are expected to be shown separately, pinned on top.
List<NoteListEntry> groupNotesByDay(List<NoteView> views, DateTime now) {
  final byDay = <int, String>{};
  final labels = [
    for (final view in views)
      byDay.putIfAbsent(
        _dayKey(view.createdAt),
        () => noteDayLabel(view.createdAt, now),
      ),
  ];
  final entries = <NoteListEntry>[];
  for (var i = 0; i < views.length; i++) {
    final isFirst = i == 0 || labels[i - 1] != labels[i];
    final isLast = i == views.length - 1 || labels[i + 1] != labels[i];
    if (isFirst) entries.add(NoteDayHeader(labels[i]));
    entries.add(NoteRow(views[i], isFirstInDay: isFirst, isLastInDay: isLast));
  }
  return entries;
}

/// "45 min", "1 h 5 min", "Under a minute"; for lists and chips.
String formatNoteLength(int ms) {
  final minutes = (ms / Duration.millisecondsPerMinute).round();
  if (minutes < 1) return 'Under a minute';
  if (minutes < 60) return '$minutes min';
  final hours = minutes ~/ 60;
  final rest = minutes % 60;
  return rest == 0 ? '$hours h' : '$hours h $rest min';
}

String formatNoteTime(DateTime createdAt) => _time.format(createdAt.toLocal());

/// Why the Ask box is disabled right now, or null when it works. [noteId]
/// scopes it to one note; null asks across all notes.
String? askUnavailableReason(
  NotesState notes, {
  String? noteId,
  required DateTime now,
}) {
  final availableAt = DateTime.tryParse(notes.askAvailableAt ?? '');
  if (availableAt != null && availableAt.isAfter(now)) {
    return "You've reached today's Ask limit. It resets "
        '${_when({'resetsAt': notes.askAvailableAt}, const ['resetsAt'], now: now)}.';
  }
  if (notes.isOffline) return "You're offline. Ask needs a connection.";
  if (noteId != null) {
    final view = buildNoteView(notes, noteId);
    if (view != null && !view.canAsk) {
      return view.state.isCapturing
          ? 'Ask works once this meeting is processed.'
          : 'Ask works once the notes are ready.';
    }
  }
  return null;
}

/// The list's second line for a note that is not being recorded (those
/// show a live timer instead): length, then state when it needs attention.
String noteStatusLine(NoteView view) {
  final ms = view.durationMs(DateTime.now());
  final isImport =
      (view.local?.source ?? view.server?.source) == NoteSource.imported;
  final length = isImport
      ? 'Imported transcript'
      : ms > 0
      ? formatNoteLength(ms)
      : null;
  final progress = view.uploadProgress;
  final state = switch (view.state) {
    NoteDisplayState.recording => 'Recording',
    NoteDisplayState.paused => 'Paused',
    NoteDisplayState.waitingForConnection => 'Waiting for connection',
    NoteDisplayState.queued => 'Queued',
    NoteDisplayState.uploading =>
      progress == null ? 'Uploading' : 'Uploading ${(progress * 100).round()}%',
    NoteDisplayState.processing => 'Writing notes',
    NoteDisplayState.failed => "Couldn't process",
    NoteDisplayState.draft => 'Not processed',
    NoteDisplayState.ready =>
      view.failedSegmentError == null ? null : "Part couldn't be transcribed",
  };
  return [?length, ?state].join(' · ');
}
