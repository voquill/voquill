import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/actions/snackbar_actions.dart';
import 'package:app/api/local_note_store.dart';
import 'package:app/api/note_recorder_api.dart';
import 'package:app/api/notes_api.dart';
import 'package:app/model/common_model.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/notes_state.dart';
import 'package:app/state/snackbar_state.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/adts_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:app/utils/note_lifecycle_utils.dart';
import 'package:app/utils/note_utils.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

final _logger = createNamedLogger('notes_actions');

const _pageSize = 50;

class NotesServices {
  NotesServices({
    required this.api,
    required this.store,
    required this.recorder,
    this.pollInterval = const Duration(seconds: 3),
    this.maxPollInterval = const Duration(seconds: 15),
    this.retryDelays = const [
      Duration(seconds: 5),
      Duration(seconds: 15),
      Duration(seconds: 30),
      Duration(seconds: 60),
    ],
  });

  final NotesApi api;
  final LocalNoteStore store;
  final NoteRecorder recorder;
  final Duration pollInterval;
  final Duration maxPollInterval;

  /// Backoff for automatic retries after transient failures; empty disables
  /// them (tests drive retries explicitly).
  final List<Duration> retryDelays;
}

NotesServices? _services;
StreamSubscription<NoteRecorderEvent>? _recorderSubscription;
Timer? _retryTimer;
int _retryAttempt = 0;
Timer? _editFlushTimer;
final _syncs = <String, Future<void>>{};
final _watchingIds = <String>{};
final _openNoteRequests = StreamController<String>.broadcast();

/// Note ids the UI should open (Live Activity / notification taps).
Stream<String> get openNoteRequests => _openNoteRequests.stream;

NotesState get _notes => getAppState().notes;

LocalNote? _local(String id) => _notes.localNoteById[id];

void _produceNotes(void Function(NotesStateDraft notes) update) {
  produceAppState((draft) => update(draft.notes));
}

Future<void> _persist() async {
  final services = _services;
  if (services == null) return;
  final notes = _notes;
  await services.store.saveSnapshot(
    LocalNotesSnapshot(
      localNotes: notes.localNoteById.values.toList(),
      pendingEdits: notes.pendingEditById,
      pendingDeleteIds: notes.pendingDeleteIds,
    ),
  );
}

Future<void> _saveCache() async {
  final services = _services;
  if (services == null) return;
  final notes = _notes;
  await services.store.saveCachedNotes(
    notes.serverNoteIds
        .take(_pageSize)
        .map((id) => notes.noteById[id])
        .whereType<Note>()
        .toList(),
  );
}

/// Applies [event] to the note's lifecycle; false when it is not a valid
/// transition from the current phase.
bool _transition(
  String id,
  LocalNoteEvent event, [
  void Function(LocalNoteDraft note)? update,
]) {
  var applied = false;
  _produceNotes((notes) {
    final note = notes.localNoteById[id];
    if (note == null) return;
    final next = nextLocalNotePhase(note.phase, event);
    if (next == null) return;
    note.phase = next;
    update?.call(note);
    applied = true;
  });
  if (!applied) {
    _logger.w('Ignored ${event.name} for note in ${_local(id)?.phase}');
  }
  return applied;
}

void _updateLocal(String id, void Function(LocalNoteDraft note) update) {
  _produceNotes((notes) {
    final note = notes.localNoteById[id];
    if (note != null) update(note);
  });
}

void _setSyncStatus(String id, NoteSyncStatus? status) {
  _produceNotes((notes) {
    if (status == null) {
      notes.syncById.remove(id);
    } else {
      notes.syncById[id] = status.draft();
    }
  });
}

/// Keeps fetched segments when the incoming copy (list, PATCH) omits them
/// and the audio did not change.
void _storeServerNote(NotesStateDraft notes, Note note) {
  final existing = notes.noteById[note.id];
  final keepSegments =
      note.segments == null &&
      existing?.segments != null &&
      existing!.durationMs == note.durationMs &&
      existing.status == note.status;
  notes.noteById[note.id] = keepSegments
      ? note.copyWithSegments(existing.segments)
      : note;
  if (!notes.serverNoteIds.contains(note.id)) {
    notes.serverNoteIds = [note.id, ...notes.serverNoteIds];
  }
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

Future<void> initializeNotes(NotesServices services) async {
  await disposeNotes();
  _services = services;

  final snapshot = await services.store.loadSnapshot();
  final cached = await services.store.loadCachedNotes();
  NoteRecorderState? native;
  try {
    native = await services.recorder.getState();
  } catch (e) {
    _logger.w('Could not read recorder state', e);
  }

  final localNotes = <LocalNote>[];
  for (final note in snapshot.localNotes) {
    localNotes.add(await _reenterAfterRestart(note, native));
  }
  if (native != null && !localNotes.any((n) => n.id == native!.noteId)) {
    await services.recorder.stop();
  }

  _produceNotes((notes) {
    notes.localNoteById = {for (final n in localNotes) n.id: n};
    notes.pendingEditById = snapshot.pendingEdits;
    notes.pendingDeleteIds = snapshot.pendingDeleteIds;
    notes.noteById = {for (final n in cached) n.id: n};
    notes.serverNoteIds = cached.map((n) => n.id).toList();
    notes.isInitialized = true;
  });
  await _persist();

  _recorderSubscription = services.recorder.events.listen(_onRecorderEvent);
  final pending = await services.recorder.takePendingAction().catchError((
    Object e,
  ) {
    _logger.w('Could not read pending recorder action', e);
    return null;
  });
  if (pending != null) _onRecorderEvent(pending);

  unawaited(refreshNotes());
  unawaited(syncAllNotes());
}

Future<LocalNote> _reenterAfterRestart(
  LocalNote note,
  NoteRecorderState? native,
) async {
  final isRecorderActive = native?.noteId == note.id;
  final phase = phaseAfterRestart(
    note.phase,
    isRecorderActive: isRecorderActive,
  );
  if (note.isCapturing && isRecorderActive) {
    return _withNativeState(note, native!);
  }
  final closed = note.isCapturing ? await _closeOpenSegments(note) : note;
  return (closed.draft()..phase = phase).save();
}

Future<void> disposeNotes() async {
  _retryTimer?.cancel();
  _retryTimer = null;
  _retryAttempt = 0;
  _editFlushTimer?.cancel();
  _editFlushTimer = null;
  await _recorderSubscription?.cancel();
  _recorderSubscription = null;
  final services = _services;
  _services = null;
  if (services != null) {
    if (_notes.capturingNote != null) await _stopRecorderQuietly(services);
    await services.store.flush();
  }
  _syncs.clear();
  _watchingIds.clear();
  produceAppState((draft) => draft.notes = const NotesState());
}

Future<void> _stopRecorderQuietly(NotesServices services) async {
  try {
    await services.recorder.stop();
  } catch (e) {
    _logger.w('Failed to stop recorder', e);
  }
}

// ---------------------------------------------------------------------------
// Recording
// ---------------------------------------------------------------------------

bool get isMeetingRecording =>
    _notes.capturingNote?.phase == LocalNotePhase.recording;

LocalNote _withNativeState(LocalNote note, NoteRecorderState native) {
  final draft = note.draft();
  draft.phase = native.isPaused
      ? LocalNotePhase.paused
      : LocalNotePhase.recording;
  draft.recordingStartedAt = native.isPaused
      ? null
      : DateTime.now().toUtc().toIso8601String();
  for (final segment in draft.segments) {
    if (segment.id == native.segmentId) {
      segment.isOpen = true;
      segment.durationMs = native.segmentElapsedMs;
    }
  }
  return draft.save();
}

/// Closes segments the native recorder no longer writes, measuring each file;
/// files without a single complete audio frame are dropped.
Future<LocalNote> _closeOpenSegments(LocalNote note) async {
  final store = _services!.store;
  final segments = <LocalNoteSegment>[];
  for (final segment in note.segments) {
    if (!segment.isOpen) {
      segments.add(segment);
      continue;
    }
    final file = store.segmentFile(note.id, segment.fileName);
    final durationMs = await readAdtsDurationMs(file);
    if (durationMs == 0) {
      if (await file.exists()) await file.delete();
      continue;
    }
    segments.add(
      (segment.draft()
            ..isOpen = false
            ..durationMs = durationMs)
          .save(),
    );
  }
  final draft = note.draft()
    ..segments = segments
    ..recordingStartedAt = null;
  return draft.save();
}

void _onRecorderEvent(NoteRecorderEvent event) {
  switch (event) {
    case NoteRecorderStateEvent(:final state):
      final note = _local(state.noteId);
      if (note == null || !note.isCapturing) return;
      _produceNotes(
        (notes) => notes.localNoteById[note.id] = _withNativeState(
          note,
          state,
        ).draft(),
      );
      unawaited(_persist());
    case NoteRecorderActionEvent(:final action, :final noteId):
      if (action == NoteRecorderAction.stop) unawaited(stopRecording(noteId));
      _openNoteRequests.add(noteId);
  }
}

Future<bool> _ensureCanRecord() async {
  final capturing = _notes.capturingNote;
  if (capturing != null) {
    showSnackbar('Finish your current meeting before starting another one.');
    return false;
  }
  final remote = getAppState().remote.sessionById.values;
  if (remote.any((s) => s.isRecording)) {
    showSnackbar('Stop dictating to your computer before recording a meeting.');
    return false;
  }
  final mic = await Permission.microphone.request();
  if (!mic.isGranted) {
    showSnackbar(
      'Voquill needs microphone access to take meeting notes. You can allow it in Settings.',
    );
    return false;
  }
  if (Platform.isAndroid) await Permission.notification.request();
  return true;
}

/// Creates a note, starts recording and returns its id.
Future<String?> startNewNote() async {
  final services = _services;
  if (services == null || !await _ensureCanRecord()) return null;
  final now = DateTime.now();
  final note = LocalNote(
    id: const Uuid().v4(),
    title: defaultNoteTitle(now),
    createdAt: now.toUtc().toIso8601String(),
    phase: LocalNotePhase.recording,
  );
  return await _startSegment(note, previous: null) ? note.id : null;
}

/// Records more audio into a note the server already finished.
Future<bool> resumeServerNote(String id) async {
  final services = _services;
  final view = buildNoteView(_notes, id);
  final server = view?.server;
  if (services == null || server == null || view!.local != null) return false;
  if (!await _ensureCanRecord()) return false;
  final note = LocalNote(
    id: id,
    title: view.title,
    titleSource: server.titleSource,
    personalNotes: view.personalNotes,
    createdAt: server.createdAt,
    phase: LocalNotePhase.recording,
    priorDurationMs: server.durationMs,
    existsOnServer: true,
  );
  return _startSegment(note, previous: null);
}

/// Persists a new open segment, then starts the native recorder on it. On
/// failure the note goes back to [previous] (or disappears if it was new).
Future<bool> _startSegment(
  LocalNote note, {
  required LocalNote? previous,
}) async {
  final services = _services!;
  final segmentId = const Uuid().v4();
  final segment = LocalNoteSegment(
    id: segmentId,
    fileName: '$segmentId.aac',
    isOpen: true,
  );
  final file = services.store.segmentFile(note.id, segment.fileName);
  await file.parent.create(recursive: true);

  final priorElapsedMs = note.elapsedMs(DateTime.now());
  final started =
      (note.draft()
            ..segments = [...note.segments, segment]
            ..phase = LocalNotePhase.recording
            ..recordingStartedAt = DateTime.now().toUtc().toIso8601String()
            ..error = null)
          .save();
  _produceNotes((notes) => notes.localNoteById[note.id] = started.draft());
  await _persist();

  try {
    await services.recorder.start(
      noteId: note.id,
      segmentId: segmentId,
      path: file.path,
      priorElapsedMs: priorElapsedMs,
    );
    return true;
  } catch (e) {
    _logger.e('Failed to start recording', e);
    _produceNotes((notes) {
      if (previous == null) {
        notes.localNoteById.remove(note.id);
      } else {
        notes.localNoteById[note.id] = previous.draft();
      }
    });
    await _persist();
    if (previous == null && !note.existsOnServer) {
      await services.store.deleteNoteFiles(note.id);
    } else if (await file.exists()) {
      await file.delete();
    }
    showSnackbar(
      'The microphone could not be started. Close other apps using it and try again.',
      type: SnackbarType.error,
    );
    return false;
  }
}

Future<void> pauseRecording(String id) async {
  final services = _services;
  final note = _local(id);
  if (services == null || note?.phase != LocalNotePhase.recording) return;
  final native = await services.recorder.pause();
  final now = DateTime.now();
  _transition(id, LocalNoteEvent.pause, (draft) {
    final startedAt = draft.recordingStartedAt;
    for (final segment in draft.segments.where((s) => s.isOpen)) {
      segment.durationMs =
          native?.segmentElapsedMs ??
          segment.durationMs +
              (startedAt == null
                  ? 0
                  : now.difference(DateTime.parse(startedAt)).inMilliseconds);
    }
    draft.recordingStartedAt = null;
  });
  await _persist();
}

Future<void> resumeRecording(String id) async {
  final services = _services;
  final note = _local(id);
  if (services == null || note?.phase != LocalNotePhase.paused) return;
  final native = await services.recorder.getState();
  if (native?.noteId == id) {
    final resumed = await services.recorder.resume();
    if (resumed != null) {
      _produceNotes(
        (notes) =>
            notes.localNoteById[id] = _withNativeState(note!, resumed).draft(),
      );
      await _persist();
    }
    return;
  }
  if (!await Permission.microphone.request().then((s) => s.isGranted)) {
    showSnackbar('Voquill needs microphone access to keep recording.');
    return;
  }
  final closed = await _closeOpenSegments(note!);
  await _startSegment(closed, previous: closed);
}

/// Finishes the meeting and queues it for upload and processing.
Future<void> stopRecording(String id) async {
  final services = _services;
  if (services == null || !(_local(id)?.isCapturing ?? false)) return;
  final native = await services.recorder.getState();
  if (native?.noteId == id) await services.recorder.stop();

  final note = _local(id);
  if (note == null) return;
  final closed = await _closeOpenSegments(note);
  final hasNewAudio = closed.segments.isNotEmpty;

  if (!hasNewAudio && closed.existsOnServer) {
    _produceNotes((notes) => notes.localNoteById.remove(id));
    await _persist();
    await services.store.deleteNoteFiles(id);
    return;
  }
  if (!hasNewAudio) {
    _produceNotes(
      (notes) =>
          notes.localNoteById[id] = (closed.draft()
            ..phase = LocalNotePhase.paused),
    );
    await _persist();
    showSnackbar(
      'No audio was recorded yet. Resume recording or delete the note.',
    );
    return;
  }

  _produceNotes((notes) => notes.localNoteById[id] = closed.draft());
  _transition(id, LocalNoteEvent.stop);
  await _persist();
  unawaited(syncLocalNote(id, isUserInitiated: true));
}

// ---------------------------------------------------------------------------
// Sync
// ---------------------------------------------------------------------------

/// Runs the finish flow for one local note from whatever step it is at:
/// PUT → upload each segment → process → poll → store result → delete audio.
/// Every step is idempotent, so a crash or failure at any point is retried
/// from the persisted state.
Future<void> syncLocalNote(String id, {bool isUserInitiated = false}) {
  final services = _services;
  if (services == null) return Future.value();
  return _syncs[id] ??=
      _syncLocalNote(
        services,
        id,
        isUserInitiated: isUserInitiated,
      ).whenComplete(() {
        _syncs.remove(id);
      });
}

Future<void> _syncLocalNote(
  NotesServices services,
  String id, {
  required bool isUserInitiated,
}) async {
  unawaited(services.recorder.setSyncActive(true).catchError((_) {}));
  try {
    await _runSync(services, id);
    _retryAttempt = 0;
  } on NotesApiException catch (e) {
    _handleSyncFailure(id, e, isUserInitiated: isUserInitiated);
  } catch (e, stack) {
    _logger.e('Note sync failed', e, stack);
    _transition(
      id,
      LocalNoteEvent.fail,
      (note) => note.error = const NoteError(
        code: 'client_error',
        message: 'Something went wrong on this device.',
      ),
    );
  } finally {
    _produceNotes((notes) {
      notes.syncById[id]?.uploadProgress = null;
    });
    await _persist();
    if (_syncs.length <= 1) {
      unawaited(services.recorder.setSyncActive(false).catchError((_) {}));
    }
  }
}

void _handleSyncFailure(
  String id,
  NotesApiException e, {
  required bool isUserInitiated,
}) {
  _logger.w('Note sync stopped: ${e.code} (${e.statusCode})');
  if (e.isTransient) {
    if (_local(id)?.phase == LocalNotePhase.uploading) {
      _transition(id, LocalNoteEvent.uploadInterrupted);
    }
    _setSyncStatus(id, NoteSyncStatus(isWaitingForConnection: e.isNetwork));
    _scheduleRetry();
    return;
  }
  if (e.isNotFound) {
    _updateLocal(id, (note) {
      note.existsOnServer = false;
      for (final segment in note.segments) {
        segment.isUploaded = false;
        segment.uploadUrl = null;
      }
    });
  }
  _transition(id, LocalNoteEvent.fail, (note) => note.error = e.toNoteError());
  if (e.isQuota && isUserInitiated) presentPaywall();
}

Future<void> _runSync(NotesServices services, String id) async {
  var note = _local(id);
  if (note == null) return;
  _setSyncStatus(id, const NoteSyncStatus());

  if (note.phase == LocalNotePhase.pendingUpload ||
      note.phase == LocalNotePhase.uploading) {
    _transition(id, LocalNoteEvent.startUpload);
    final server = note.source == NoteSource.imported
        ? await _sendImport(services, note)
        : await _uploadAndProcess(services, id);
    _produceNotes((notes) => _storeServerNote(notes, server));
    _transition(id, LocalNoteEvent.processAccepted, (n) {
      n.existsOnServer = true;
      n.error = null;
    });
    _setSyncStatus(id, null);
    await _persist();
  }

  note = _local(id);
  if (note?.phase == LocalNotePhase.processing) {
    await _pollLocalNote(services, id);
  }

  if (_local(id)?.phase == LocalNotePhase.ready) {
    await _finalizeReadyNote(services, id);
  }
}

String? _userTitle(LocalNote note) =>
    note.titleSource == NoteTitleSource.user ? note.title : null;

Future<Note> _sendImport(NotesServices services, LocalNote note) async {
  final transcript = await services.store.importFile(note.id).readAsString();
  return services.api.importNote(
    id: note.id,
    transcript: transcript,
    title: _userTitle(note),
    personalNotes: note.personalNotes.isEmpty ? null : note.personalNotes,
    createdAt: note.createdAt,
  );
}

Future<Note> _uploadAndProcess(NotesServices services, String id) async {
  final note = _local(id)!;
  await services.api.putNote(
    id,
    title: note.titleSource == NoteTitleSource.ai ? null : note.title,
    titleSource: note.titleSource,
    personalNotes: note.personalNotes,
    createdAt: note.createdAt,
  );
  _updateLocal(id, (n) => n.existsOnServer = true);
  await _persist();

  for (var attempt = 0; ; attempt++) {
    await _uploadSegments(services, id);
    final current = _local(id)!;
    try {
      return await services.api.processNote(
        id,
        title: _userTitle(current),
        personalNotes: current.personalNotes,
      );
    } on NotesApiException catch (e) {
      final missing = (e.details?['segmentIds'] as List?)?.cast<String>();
      if (e.code != 'audio_missing' || missing == null || attempt > 0) rethrow;
      _updateLocal(id, (n) {
        for (final segment in n.segments.where((s) => missing.contains(s.id))) {
          segment.isUploaded = false;
          segment.uploadUrl = null;
        }
      });
      await _persist();
    }
  }
}

Future<void> _uploadSegments(NotesServices services, String id) async {
  final pending = _local(id)!.segments.where((s) => !s.isUploaded).toList();
  final sizes = <String, int>{};
  for (final segment in pending) {
    sizes[segment.id] = await services.store
        .segmentFile(id, segment.fileName)
        .length();
  }
  final totalBytes = max(1, sizes.values.fold<int>(0, (a, b) => a + b));
  var doneBytes = 0;

  void reportProgress(int bytes) {
    _produceNotes((notes) {
      notes.syncById[id] = NoteSyncStatus(
        uploadProgress: (bytes / totalBytes).clamp(0.0, 1.0),
      ).draft();
    });
  }

  for (final segment in pending) {
    final size = sizes[segment.id]!;
    final file = services.store.segmentFile(id, segment.fileName);
    var uploadUrl = segment.uploadUrl;
    var offset = 0;

    if (uploadUrl != null) {
      try {
        offset = await services.api.queryUploadOffset(uploadUrl, size);
      } on NotesApiException catch (e) {
        if (e.statusCode != 404 && e.statusCode != 410) rethrow;
        uploadUrl = null;
      }
    }
    if (uploadUrl == null) {
      try {
        uploadUrl = await services.api.createSegmentUpload(
          id,
          segment.id,
          durationMs: segment.durationMs,
          sizeBytes: size,
        );
      } on NotesApiException catch (e) {
        if (e.code != 'segment_transcribed') rethrow;
        offset = size;
      }
      if (uploadUrl != null) {
        final url = uploadUrl;
        _updateLocal(id, (n) {
          n.segments.firstWhere((s) => s.id == segment.id).uploadUrl = url;
        });
        await _persist();
      }
    }

    if (offset < size) {
      offset = await services.api.uploadBytes(
        uploadUrl!,
        file,
        offset: offset,
        totalBytes: size,
        onProgress: (sent) => reportProgress(doneBytes + sent),
      );
      if (offset < size) {
        throw const NotesApiException.network('The upload was cut off.');
      }
    }

    doneBytes += size;
    reportProgress(doneBytes);
    _updateLocal(id, (n) {
      n.segments.firstWhere((s) => s.id == segment.id).isUploaded = true;
    });
    await _persist();
  }
}

/// Polls with backoff while [isWanted] holds and the note is processing;
/// returns the last copy seen, or null when polling was abandoned.
Future<Note?> _pollWhileProcessing(
  NotesServices services,
  String id,
  bool Function() isWanted,
) async {
  var delay = services.pollInterval;
  while (isWanted()) {
    final note = await services.api.getNote(id);
    _produceNotes((notes) => _storeServerNote(notes, note));
    if (note.status != NoteStatus.processing) return note;
    await Future.delayed(delay);
    final next = delay * 1.5;
    delay = next > services.maxPollInterval ? services.maxPollInterval : next;
  }
  return null;
}

Future<void> _pollLocalNote(NotesServices services, String id) async {
  bool isWanted() => _local(id)?.phase == LocalNotePhase.processing;
  while (true) {
    final note = await _pollWhileProcessing(services, id, isWanted);
    if (note == null) return;
    switch (note.status) {
      case NoteStatus.ready:
        _transition(id, LocalNoteEvent.serverReady);
        await _persist();
        return;
      case NoteStatus.failed:
        _transition(
          id,
          LocalNoteEvent.fail,
          (n) => n.error =
              note.error ??
              const NoteError(code: 'processing_failed', message: ''),
        );
        await _persist();
        return;
      case NoteStatus.draft:
        final local = _local(id)!;
        final processed = await services.api.processNote(
          id,
          title: _userTitle(local),
          personalNotes: local.personalNotes,
        );
        _produceNotes((notes) => _storeServerNote(notes, processed));
      case NoteStatus.processing:
        return;
    }
  }
}

/// The server holds the transcript and notes: make sure the full result is
/// stored locally, then (and only then) delete the local audio.
Future<void> _finalizeReadyNote(NotesServices services, String id) async {
  var server = _notes.noteById[id];
  if (server?.status != NoteStatus.ready || server?.segments == null) {
    server = await services.api.getNote(id);
    final fetched = server;
    _produceNotes((notes) => _storeServerNote(notes, fetched));
  }
  if (server!.status != NoteStatus.ready) return;
  await _saveCache();
  await services.store.deleteNoteFiles(id);
  _produceNotes((notes) {
    notes.localNoteById.remove(id);
    notes.syncById.remove(id);
  });
  await _persist();
}

void _scheduleRetry() {
  final delays = _services?.retryDelays ?? const [];
  if (delays.isEmpty || _retryTimer?.isActive == true) return;
  final delay = delays[min(_retryAttempt, delays.length - 1)];
  _retryAttempt++;
  _retryTimer = Timer(delay, () => unawaited(syncAllNotes()));
}

/// Flushes queued deletes and edits and resumes every unfinished note.
Future<void> syncAllNotes() async {
  if (_services == null) return;
  _retryTimer?.cancel();
  await _flushPendingDeletes();
  await _flushPendingEdits();
  final ids = _notes.localNoteById.values
      .where((n) => localNoteNeedsSync(n.phase))
      .map((n) => n.id)
      .toList();
  await Future.wait(ids.map(syncLocalNote));
}

Future<void> retryNote(String id) async {
  final services = _services;
  if (services == null) return;
  if (_local(id) != null) {
    if (_transition(id, LocalNoteEvent.retry, (n) => n.error = null)) {
      await _persist();
    }
    await syncLocalNote(id, isUserInitiated: true);
    return;
  }
  await _runServerAction(() => services.api.processNote(id));
}

Future<void> regenerateNote(String id) async {
  final services = _services;
  if (services == null) return;
  await _runServerAction(() => services.api.regenerateNote(id));
}

/// Starts server-side work on a note that has no local copy and follows it
/// until it settles.
Future<void> _runServerAction(Future<Note> Function() action) async {
  try {
    final note = await action();
    _produceNotes((notes) => _storeServerNote(notes, note));
    unawaited(watchServerNote(note.id));
  } on NotesApiException catch (e) {
    if (e.isQuota) presentPaywall();
    showSnackbar(
      e.isNetwork ? "You're offline. Try again when connected." : e.message,
      type: SnackbarType.error,
    );
  }
}

/// Polls a server-only note while it is processing (regenerate, other device).
Future<void> watchServerNote(String id) async {
  final services = _services;
  if (services == null || !_watchingIds.add(id)) return;
  try {
    await _pollWhileProcessing(
      services,
      id,
      () => _services == services && _local(id) == null,
    );
  } on NotesApiException catch (e) {
    _logger.w('Stopped watching note: ${e.code}');
  } finally {
    _watchingIds.remove(id);
  }
}

// ---------------------------------------------------------------------------
// Server list, detail, search, ask
// ---------------------------------------------------------------------------

Future<void> refreshNotes() async {
  final services = _services;
  if (services == null) return;
  _produceNotes((notes) => notes.listStatus = ActionStatus.loading);
  try {
    final page = await services.api.listNotes(limit: _pageSize);
    _produceNotes((notes) {
      for (final note in page.notes) {
        _storeServerNote(notes, note);
      }
      notes.serverNoteIds = page.notes.map((n) => n.id).toList();
      notes.nextCursor = page.nextCursor;
      notes.listStatus = ActionStatus.success;
    });
    await _saveCache();
  } on NotesApiException catch (e) {
    _logger.w('Failed to load notes: ${e.code}');
    _produceNotes((notes) => notes.listStatus = ActionStatus.error);
  }
}

Future<void> loadMoreNotes() async {
  final services = _services;
  final cursor = _notes.nextCursor;
  if (services == null || cursor == null || _notes.listStatus.isLoading) {
    return;
  }
  _produceNotes((notes) => notes.listStatus = ActionStatus.loading);
  try {
    final page = await services.api.listNotes(limit: _pageSize, cursor: cursor);
    _produceNotes((notes) {
      for (final note in page.notes) {
        _storeServerNote(notes, note);
      }
      notes.serverNoteIds = [
        ...notes.serverNoteIds,
        ...page.notes
            .map((n) => n.id)
            .where((id) => !notes.serverNoteIds.contains(id)),
      ];
      notes.nextCursor = page.nextCursor;
      notes.listStatus = ActionStatus.success;
    });
  } on NotesApiException catch (e) {
    _logger.w('Failed to load more notes: ${e.code}');
    _produceNotes((notes) => notes.listStatus = ActionStatus.error);
  }
}

/// Fetches the full note (segments and transcripts).
Future<void> loadNote(String id) async {
  final services = _services;
  if (services == null || _notes.pendingDeleteIds.contains(id)) return;
  try {
    final note = await services.api.getNote(id);
    _produceNotes((notes) => _storeServerNote(notes, note));
    if (note.status == NoteStatus.processing && _local(id) == null) {
      unawaited(watchServerNote(id));
    }
  } on NotesApiException catch (e) {
    _logger.w('Failed to load note: ${e.code}');
  }
}

Future<List<NoteSearchResult>> searchNotes(String query) async {
  final services = _services;
  if (services == null) return const [];
  final results = await services.api.searchNotes(query);
  _produceNotes((notes) {
    for (final result in results) {
      if (!notes.noteById.containsKey(result.note.id)) {
        notes.noteById[result.note.id] = result.note;
      }
    }
  });
  return results;
}

Stream<NoteAskEvent> askNotes({
  required String question,
  String? noteId,
  List<NoteAskMessage> history = const [],
}) {
  final services = _services;
  if (services == null) return const Stream.empty();
  return services.api.ask(question: question, noteId: noteId, history: history);
}

// ---------------------------------------------------------------------------
// Import, edits, delete
// ---------------------------------------------------------------------------

const _importDefaultTitle = 'Imported transcript';

Future<void> importTranscript({
  required String transcript,
  String title = '',
}) async {
  final services = _services;
  if (services == null) return;
  final id = const Uuid().v4();
  final trimmedTitle = title.trim();
  await services.store.writeImportTranscript(id, transcript);
  final note = LocalNote(
    id: id,
    source: NoteSource.imported,
    title: trimmedTitle.isEmpty ? _importDefaultTitle : trimmedTitle,
    titleSource: trimmedTitle.isEmpty
        ? NoteTitleSource.defaultTitle
        : NoteTitleSource.user,
    createdAt: DateTime.now().toUtc().toIso8601String(),
    phase: LocalNotePhase.pendingUpload,
  );
  _produceNotes((notes) => notes.localNoteById[id] = note.draft());
  await _persist();
  unawaited(syncLocalNote(id, isUserInitiated: true));
}

Future<void> updateNoteTitle(String id, String title) async {
  final trimmed = title.trim();
  if (trimmed.isEmpty) return;
  await _applyEdit(id, title: trimmed);
}

Future<void> updateNotePersonalNotes(String id, String personalNotes) {
  return _applyEdit(id, personalNotes: personalNotes);
}

/// Local notes take the edit directly (the finish flow sends it); anything
/// the server already has gets a queued PATCH.
Future<void> _applyEdit(
  String id, {
  String? title,
  String? personalNotes,
}) async {
  if (_services == null) return;
  _produceNotes((notes) {
    final local = notes.localNoteById[id];
    if (local != null) {
      if (title != null) {
        local.title = title;
        local.titleSource = NoteTitleSource.user;
      }
      if (personalNotes != null) local.personalNotes = personalNotes;
      if (!local.existsOnServer) return;
    }
    final edit = notes.pendingEditById[id];
    notes.pendingEditById[id] = NoteEdit(
      title: title ?? edit?.title,
      personalNotes: personalNotes ?? edit?.personalNotes,
    ).draft();
  });
  await _persist();
  _editFlushTimer?.cancel();
  _editFlushTimer = Timer(const Duration(seconds: 2), _flushPendingEdits);
}

Future<void> _flushPendingEdits() async {
  final services = _services;
  if (services == null) return;
  for (final entry in _notes.pendingEditById.entries.toList()) {
    final id = entry.key;
    final edit = entry.value;
    final local = _local(id);
    if (local != null && !local.existsOnServer) continue;
    try {
      final note = await services.api.patchNote(
        id,
        title: edit.title,
        personalNotes: edit.personalNotes,
      );
      _produceNotes((notes) {
        if (notes.noteById.containsKey(id)) _storeServerNote(notes, note);
        final current = notes.pendingEditById[id];
        if (current?.title == edit.title &&
            current?.personalNotes == edit.personalNotes) {
          notes.pendingEditById.remove(id);
        }
      });
    } on NotesApiException catch (e) {
      if (e.isTransient) {
        _scheduleRetry();
        break;
      }
      _logger.w('Dropping note edit: ${e.code}');
      _produceNotes((notes) => notes.pendingEditById.remove(id));
    }
  }
  await _persist();
}

Future<void> deleteNote(String id) async {
  final services = _services;
  if (services == null) return;
  if (_local(id)?.isCapturing ?? false) {
    final native = await services.recorder.getState();
    if (native?.noteId == id) await services.recorder.stop();
  }
  _produceNotes((notes) {
    notes.localNoteById.remove(id);
    notes.noteById.remove(id);
    notes.serverNoteIds = notes.serverNoteIds.where((n) => n != id).toList();
    notes.pendingEditById.remove(id);
    notes.syncById.remove(id);
    if (!notes.pendingDeleteIds.contains(id)) {
      notes.pendingDeleteIds = [...notes.pendingDeleteIds, id];
    }
  });
  await _persist();
  await services.store.deleteNoteFiles(id);
  await _saveCache();
  unawaited(_flushPendingDeletes());
}

Future<void> _flushPendingDeletes() async {
  final services = _services;
  if (services == null) return;
  for (final id in _notes.pendingDeleteIds.toList()) {
    try {
      await services.api.deleteNote(id);
    } on NotesApiException catch (e) {
      if (e.isTransient) {
        _scheduleRetry();
        return;
      }
      _logger.w('Server refused note delete: ${e.code}');
    }
    _produceNotes((notes) {
      notes.pendingDeleteIds = notes.pendingDeleteIds
          .where((n) => n != id)
          .toList();
    });
    await _persist();
  }
}
