part of 'notes_actions.dart';

// Recording lifecycle: start, pause, resume, stop and native recorder events.
// Every command runs through one queue per user session and re-reads the
// note after each await. Recorder code writes only the fields it owns
// (segments, phase, recording start), never a whole copy of the note, so a
// title or My notes edit saved meanwhile is never overwritten.

/// Segments roll over well below the server's 4-hour segment cap and its
/// smallest (free plan, 120 MB) byte cap.
const noteMaxSegmentDuration = Duration(hours: 2);
const noteMaxSegmentBytes = 100 * 1000 * 1000;

/// Recording stops before the server's 8-hour note cap.
const noteMaxDuration = Duration(hours: 7, minutes: 50);
const noteMaxSegments = 50;

/// Dev and emulator builds only (see [Flavor.allowsDevOverrides]):
/// `--dart-define=NOTES_DEV_SEGMENT_SECONDS=120` rolls segments every two
/// minutes and `--dart-define=NOTES_DEV_NOTE_LIMIT_SECONDS=600` stops a note
/// after ten, so rollover and the limit can be tested in minutes.
const _devSegmentSeconds = int.fromEnvironment('NOTES_DEV_SEGMENT_SECONDS');
const _devNoteLimitSeconds = int.fromEnvironment(
  'NOTES_DEV_NOTE_LIMIT_SECONDS',
);

Duration get _segmentDuration =>
    Flavor.current.allowsDevOverrides && _devSegmentSeconds > 0
    ? Duration(seconds: _devSegmentSeconds)
    : noteMaxSegmentDuration;

/// A short dev segment length alone keeps the note within the 50-segment
/// cap by also shortening the note limit to 20 segments.
Duration get _noteLimit {
  if (!Flavor.current.allowsDevOverrides) return noteMaxDuration;
  if (_devNoteLimitSeconds > 0) return Duration(seconds: _devNoteLimitSeconds);
  if (_devSegmentSeconds > 0) return _segmentDuration * 20;
  return noteMaxDuration;
}

const _lowStorageWarningBytes = 300 * 1024 * 1024;
const _recordingBytesPerHour = 32000 ~/ 8 * 3600;

const _noteLimitMessage =
    'This note has reached the 8-hour limit. Start a new note to keep recording.';
const _tooManySegmentsMessage =
    'This note has too many recordings. Start a new note to keep recording.';
const _lowStorageMessage =
    'Not enough free storage to record. Free up some space and try again.';
const _micFailedMessage =
    'The microphone could not be started. Close other apps using it and try again.';

/// False only on Android 9 and older, where a second recorder cannot open
/// the microphone while a meeting holds it.
Future<bool> canShareMicrophoneWithMeeting() async {
  try {
    return await _noteRecorder.canShareMicrophone();
  } on PlatformException {
    return true;
  }
}

bool get isMeetingRecording =>
    getAppState().notes.liveNote?.phase == LocalNotePhase.recording;

/// Runs [command] after every earlier recording command of this session.
/// Returns null when the session ended before it could run.
Future<T?> _recorderCommand<T>(
  NotesServices services,
  Future<T> Function() command,
) {
  final completer = Completer<T?>();
  services._recorderCommands = services._recorderCommands.then((_) async {
    if (!_isCurrent(services)) {
      completer.complete(null);
      return;
    }
    _produce(services, (notes) => notes.isRecorderBusy = true);
    try {
      completer.complete(await command());
    } catch (e, stack) {
      _logger.e('Recording command failed', e, stack);
      completer.complete(null);
    } finally {
      _produce(services, (notes) => notes.isRecorderBusy = false);
    }
  });
  return completer.future;
}

int? _nextLocalIndex(List<LocalNoteSegment> segments) {
  if (segments.isEmpty || segments.any((s) => s.index == null)) return null;
  return segments.map((s) => s.index!).reduce(max) + 1;
}

/// The note fields the recorder owns.
class _RecorderFields {
  const _RecorderFields({
    required this.segments,
    required this.phase,
    this.recordingStartedAt,
  });

  final List<LocalNoteSegment> segments;
  final LocalNotePhase phase;
  final String? recordingStartedAt;
}

void _setRecorderFields(
  NotesServices services,
  String id,
  _RecorderFields fields,
) {
  _updateLocal(services, id, (note) {
    note.segments = fields.segments;
    note.phase = fields.phase;
    note.recordingStartedAt = fields.recordingStartedAt;
  });
}

/// What the native recorder reports, as recorder fields: a rolled-over
/// segment is added, the previous one closed, the phase follows
/// pause/resume.
Future<_RecorderFields> _nativeFields(
  LocalNoteStore store,
  LocalNote note,
  NoteRecorderState native,
) async {
  final segments = <LocalNoteSegment>[];
  var hasCurrent = false;
  for (final segment in note.segments) {
    if (segment.id == native.segmentId) {
      hasCurrent = true;
      segments.add(
        (segment.draft()
              ..isOpen = true
              ..durationMs = native.segmentElapsedMs)
            .save(),
      );
    } else if (segment.isOpen) {
      final closed = await _closeSegment(store, note.id, segment);
      if (closed != null) segments.add(closed);
    } else {
      segments.add(segment);
    }
  }
  if (!hasCurrent) {
    segments.add(
      LocalNoteSegment(
        id: native.segmentId,
        fileName: '${native.segmentId}.aac',
        index: _nextLocalIndex(segments),
        durationMs: native.segmentElapsedMs,
        isOpen: true,
      ),
    );
  }
  return _RecorderFields(
    segments: segments,
    phase: native.isPaused ? LocalNotePhase.paused : LocalNotePhase.recording,
    recordingStartedAt: native.isPaused
        ? null
        : DateTime.now().toUtc().toIso8601String(),
  );
}

/// Closes a segment the native recorder no longer writes, measuring it.
/// A file that holds anything is kept even if it does not parse: only the
/// server may judge captured audio. Missing or header-less files go.
Future<LocalNoteSegment?> _closeSegment(
  LocalNoteStore store,
  String noteId,
  LocalNoteSegment segment,
) async {
  final file = store.segmentFile(noteId, segment.fileName);
  final size = await file.exists() ? await file.length() : 0;
  if (size < adtsHeaderLength) {
    if (await file.exists()) await file.delete();
    return null;
  }
  return (segment.draft()
        ..isOpen = false
        ..durationMs = await readAdtsDurationMs(file))
      .save();
}

Future<List<LocalNoteSegment>> _closedSegments(
  LocalNoteStore store,
  LocalNote note,
) async {
  final segments = <LocalNoteSegment>[];
  for (final segment in note.segments) {
    if (!segment.isOpen) {
      segments.add(segment);
      continue;
    }
    final closed = await _closeSegment(store, note.id, segment);
    if (closed != null) segments.add(closed);
  }
  return segments;
}

void _onRecorderEvent(NotesServices services, NoteRecorderEvent event) {
  switch (event) {
    case NoteRecorderStateEvent(:final state):
      unawaited(
        _recorderCommand(services, () => _applyNativeState(services, state)),
      );
    case NoteRecorderActionEvent(:final action, :final noteId):
      if (action == NoteRecorderAction.stop) unawaited(stopRecording(noteId));
      _openNoteRequests.add(noteId);
  }
}

Future<void> _applyNativeState(
  NotesServices services,
  NoteRecorderState state,
) async {
  final note = _localOf(services, state.noteId);
  if (note == null || !note.isCapturing) return;
  // An event older than the state already applied (it names a segment the
  // note has since closed) would reopen that segment and close the one
  // being written.
  final segment = note.segments
      .where((s) => s.id == state.segmentId)
      .firstOrNull;
  if (segment != null && !segment.isOpen) return;
  final fields = await _nativeFields(services.store, note, state);
  if (!(_localOf(services, state.noteId)?.isCapturing ?? false)) return;
  _setRecorderFields(services, state.noteId, fields);
  final hasEnded =
      state.reason == NoteRecorderReason.writeFailed ||
      state.reason == NoteRecorderReason.error;
  _produce(services, (notes) {
    notes.isRecorderSilent = state.isSilent && !state.isPaused;
    if (hasEnded && notes.recorderNoteId == state.noteId) {
      notes.recorderNoteId = null;
    }
  });
  await _persist(services);

  switch (state.reason) {
    case NoteRecorderReason.limit:
      showSnackbar(
        'This meeting reached the 8-hour limit, so recording stopped. Everything recorded is saved.',
      );
      unawaited(stopRecording(state.noteId));
    case NoteRecorderReason.writeFailed:
      showSnackbar(
        'Recording paused: your phone is out of storage. Everything recorded so far is saved.',
        type: SnackbarType.error,
      );
    case NoteRecorderReason.error:
      showSnackbar(
        'Recording paused because the microphone stopped. Everything recorded so far is saved.',
        type: SnackbarType.error,
      );
    case NoteRecorderReason.interruption:
    case NoteRecorderReason.rollover:
    case NoteRecorderReason.user:
    case NoteRecorderReason.silence:
    case null:
      break;
  }
}

/// Why [note] cannot take another recording run, or null when it can.
String? _recordingLimitMessage(NotesServices services, LocalNote note) {
  final elapsed = note.elapsedMs(DateTime.now());
  final remainingMs = _noteLimit.inMilliseconds - elapsed;
  if (remainingMs <= const Duration(minutes: 1).inMilliseconds) {
    return _noteLimitMessage;
  }
  final localIds = note.segments.map((s) => s.id).toSet();
  final serverOnly =
      (_notesOf(services)?.noteById[note.id]?.segments ?? const [])
          .where((s) => !localIds.contains(s.id))
          .length;
  final rollovers = (remainingMs / _segmentDuration.inMilliseconds).ceil();
  if (note.segments.length + serverOnly + rollovers > noteMaxSegments) {
    return _tooManySegmentsMessage;
  }
  return null;
}

/// Checks a recording run of [note] may start or resume: the note's limits
/// and, on Android 9 and older, the microphone being free of remote
/// dictation.
Future<bool> _passesRecordingChecks(
  NotesServices services,
  LocalNote? note,
) async {
  final limit = note == null ? null : _recordingLimitMessage(services, note);
  if (limit != null) {
    showSnackbar(limit);
    return false;
  }
  if (isRemoteMicrophoneOpen && !await canShareMicrophoneWithMeeting()) {
    showSnackbar(
      'This version of Android cannot record a meeting while you dictate to your computer. Stop dictating first.',
    );
    return false;
  }
  return true;
}

/// Checks everything a new recording run needs. [note] is the note about
/// to record (null for a brand-new one). A meeting the recorder still holds
/// blocks it; a paused one whose recorder is gone (the app was closed) is
/// finished and queued for upload instead, never discarded.
Future<bool> _ensureCanRecord(NotesServices services, LocalNote? note) async {
  final notes = _notesOf(services);
  if (notes == null) return false;
  final live = notes.liveNote;
  if (live != null && live.id != note?.id) {
    showSnackbar('Finish your current meeting before starting another one.');
    return false;
  }
  final interrupted = notes.localNoteById.values
      .where((n) => n.isCapturing && n.id != note?.id && n.id != live?.id)
      .toList();
  for (final other in interrupted) {
    if (await _finishCapture(services, other.id)) {
      showSnackbar(
        '"${other.title}" was finished and is being uploaded for notes.',
      );
    }
  }
  if (!await _passesRecordingChecks(services, note)) return false;
  final mic = await Permission.microphone.request();
  if (!mic.isGranted) {
    showSnackbar(
      'Voquill needs microphone access to take meeting notes. You can allow it in Settings.',
    );
    return false;
  }
  if (Platform.isAndroid) await Permission.notification.request();
  await _warnIfStorageLow(services);
  return true;
}

Future<void> _warnIfStorageLow(NotesServices services) async {
  try {
    await services.store.root.create(recursive: true);
    final free = await services.recorder.freeBytes(services.store.root.path);
    if (free < _lowStorageWarningBytes) {
      final hours = free ~/ _recordingBytesPerHour;
      showSnackbar(
        'Storage is low: there is room for about $hours hours of recording.',
      );
    }
  } on PlatformException catch (e) {
    _logger.w('Could not read free storage', e);
  }
}

void _showRecorderError(PlatformException e) {
  showSnackbar(
    e.code == noteRecorderLowStorageCode
        ? _lowStorageMessage
        : _micFailedMessage,
    type: SnackbarType.error,
  );
}

/// Creates a note, starts recording and returns its id.
Future<String?> startNewNote() async {
  final services = _services;
  if (services == null) return null;
  return _recorderCommand<String?>(services, () async {
    if (!await _ensureCanRecord(services, null)) return null;
    final now = DateTime.now();
    final note = LocalNote(
      id: const Uuid().v4(),
      title: defaultNoteTitle(now),
      createdAt: now.toUtc().toIso8601String(),
      phase: LocalNotePhase.recording,
    );
    if (!await _startNewNoteSegment(services, note, index: 0)) return null;
    unawaited(_createOnServer(services, note.id));
    return note.id;
  });
}

/// Records more audio into a note the server already finished.
Future<bool> resumeServerNote(String id) async {
  final services = _services;
  if (services == null) return false;
  final started = await _recorderCommand(services, () async {
    final notes = _notesOf(services);
    final view = notes == null ? null : buildNoteView(notes, id);
    final server = view?.server;
    if (view == null || server == null) return false;
    final local = view.local;
    if (local != null) {
      if (local.phase != LocalNotePhase.ready) return false;
      if (!await _ensureCanRecord(services, local)) return false;
      return _startNextSegment(services, id);
    }
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
    if (!await _ensureCanRecord(services, note)) return false;
    final serverIndexes = server.segments?.map((s) => s.index);
    return _startNewNoteSegment(
      services,
      note,
      index: serverIndexes == null
          ? null
          : serverIndexes.fold<int>(-1, max) + 1,
    );
  });
  return started ?? false;
}

/// Next segment position, or null when it depends on server segments this
/// device never saw (the server then appends).
int? _nextSegmentIndex(NotesServices services, LocalNote note) {
  final local = _nextLocalIndex(note.segments);
  if (local == null) return null;
  final server = _notesOf(services)?.noteById[note.id]?.segments;
  if (server == null || server.isEmpty) return local;
  return max(local, server.map((s) => s.index).reduce(max) + 1);
}

LocalNoteSegment _newSegment(int? index) {
  final segmentId = const Uuid().v4();
  return LocalNoteSegment(
    id: segmentId,
    fileName: '$segmentId.aac',
    index: index,
    isOpen: true,
  );
}

/// Starts the native recorder on [segment]; null on success.
Future<PlatformException?> _startNative(
  NotesServices services,
  String noteId,
  LocalNoteSegment segment,
  int priorElapsedMs,
) async {
  try {
    await services.recorder.start(
      noteId: noteId,
      segmentId: segment.id,
      path: services.store.segmentFile(noteId, segment.fileName).path,
      priorElapsedMs: priorElapsedMs,
      maxSegmentMs: _segmentDuration.inMilliseconds,
      maxSegmentBytes: noteMaxSegmentBytes,
      maxNoteMs: _noteLimit.inMilliseconds,
    );
    _produce(services, (notes) {
      notes.recorderNoteId = noteId;
      notes.isRecorderSilent = false;
    });
    return null;
  } on PlatformException catch (e) {
    _logger.e('Failed to start recording: ${e.code}');
    return e;
  }
}

/// A brand-new local note (new meeting, or resuming a server note) and its
/// first segment. On failure the note disappears again.
Future<bool> _startNewNoteSegment(
  NotesServices services,
  LocalNote note, {
  required int? index,
}) async {
  final segment = _newSegment(index);
  await services.store.noteDirectory(note.id).create(recursive: true);
  if (!_isCurrent(services)) return false;
  _putLocal(
    services,
    (note.draft()
          ..segments = [segment]
          ..phase = LocalNotePhase.recording
          ..recordingStartedAt = DateTime.now().toUtc().toIso8601String())
        .save(),
  );
  await _persist(services);

  final error = await _startNative(
    services,
    note.id,
    segment,
    note.elapsedMs(DateTime.now()),
  );
  if (error == null) return true;
  _produce(services, (notes) => notes.localNoteById.remove(note.id));
  await _persist(services);
  await services.store.deleteSegmentFile(note.id, segment.fileName);
  _showRecorderError(error);
  return false;
}

/// One more segment for a note that is paused (recorder gone) or ready.
/// On failure only the recorder fields go back.
Future<bool> _startNextSegment(NotesServices services, String id) async {
  final note = _localOf(services, id);
  if (note == null) return false;
  final phase = nextLocalNotePhase(note.phase, LocalNoteEvent.resume);
  if (phase == null) return false;
  final segment = _newSegment(_nextSegmentIndex(services, note));
  await services.store.noteDirectory(id).create(recursive: true);

  final current = _localOf(services, id);
  if (current == null) return false;
  final previous = _RecorderFields(
    segments: current.segments,
    phase: current.phase,
  );
  _setRecorderFields(
    services,
    id,
    _RecorderFields(
      segments: [...current.segments, segment],
      phase: phase,
      recordingStartedAt: DateTime.now().toUtc().toIso8601String(),
    ),
  );
  _updateLocal(services, id, (n) => n.error = null);
  await _persist(services);

  final error = await _startNative(
    services,
    id,
    segment,
    current.elapsedMs(DateTime.now()),
  );
  if (error == null) return true;
  _setRecorderFields(services, id, previous);
  await _persist(services);
  await services.store.deleteSegmentFile(id, segment.fileName);
  _showRecorderError(error);
  return false;
}

Future<void> pauseRecording(String id) async {
  final services = _services;
  if (services == null) return;
  await _recorderCommand(services, () async {
    if (_localOf(services, id)?.phase != LocalNotePhase.recording) return;
    NoteRecorderState? native;
    try {
      native = await services.recorder.pause();
    } on PlatformException catch (e) {
      _logger.w('Pause failed: ${e.code}');
    }
    final now = DateTime.now();
    _transition(services, id, LocalNoteEvent.pause, (draft) {
      final startedAt = draft.recordingStartedAt;
      final ranMs = startedAt == null
          ? 0
          : now.difference(DateTime.parse(startedAt)).inMilliseconds;
      for (final segment in draft.segments.where((s) => s.isOpen)) {
        segment.durationMs = native?.segmentId == segment.id
            ? native!.segmentElapsedMs
            : segment.durationMs + ranMs;
      }
      draft.recordingStartedAt = null;
    });
    _produce(services, (notes) => notes.isRecorderSilent = false);
    await _persist(services);
  });
}

Future<void> resumeRecording(String id) async {
  final services = _services;
  if (services == null) return;
  await _recorderCommand(services, () async {
    final note = _localOf(services, id);
    if (note?.phase != LocalNotePhase.paused) return;
    final native = await services.recorder.getState();
    if (native?.noteId == id) {
      if (!await _passesRecordingChecks(services, note)) return;
      NoteRecorderState? resumed;
      try {
        resumed = await services.recorder.resume();
      } on PlatformException catch (e) {
        _showRecorderError(e);
        return;
      }
      final current = _localOf(services, id);
      if (resumed == null || current == null) return;
      _setRecorderFields(
        services,
        id,
        await _nativeFields(services.store, current, resumed),
      );
      await _persist(services);
      return;
    }
    if (!await _ensureCanRecord(services, note)) return;
    final current = _localOf(services, id);
    if (current?.phase != LocalNotePhase.paused) return;
    _setRecorderFields(
      services,
      id,
      _RecorderFields(
        segments: await _closedSegments(services.store, current!),
        phase: LocalNotePhase.paused,
      ),
    );
    await _startNextSegment(services, id);
  });
}

/// Finishes the meeting and queues it for upload and processing.
Future<void> stopRecording(String id) async {
  final services = _services;
  if (services == null) return;
  await _recorderCommand(services, () => _finishCapture(services, id));
}

/// Stops the recorder (if it holds [id]), closes the segments and queues
/// the note. Runs inside a recorder command. Returns whether audio was
/// queued.
Future<bool> _finishCapture(NotesServices services, String id) async {
  if (!(_localOf(services, id)?.isCapturing ?? false)) return false;
  // Keep the process alive from the moment recording stops until the
  // upload has taken over, so the service never stops in between.
  final releaseKeepAlive = _holdKeepAlive(services);
  try {
    try {
      final native = await services.recorder.getState();
      if (native?.noteId == id) {
        final last = await services.recorder.stop();
        final note = _localOf(services, id);
        if (last != null && note != null) {
          // A rollover the event stream has not delivered yet.
          _setRecorderFields(
            services,
            id,
            await _nativeFields(services.store, note, last),
          );
        }
      }
    } on PlatformException catch (e) {
      _logger.w('Stop failed: ${e.code}');
    }
    _produce(services, (notes) {
      if (notes.recorderNoteId == id) notes.recorderNoteId = null;
      notes.isRecorderSilent = false;
    });

    final note = _localOf(services, id);
    if (note == null) return false;
    final runSegmentIds = note.segments
        .where((s) => s.isOpen)
        .map((s) => s.id)
        .toSet();
    final segments = await _closedSegments(services.store, note);
    final current = _localOf(services, id);
    if (current == null) return false;
    // Audio from this run, or recovered after a crash, that the server lacks.
    final hasAudioToSend = segments.any(
      (s) => runSegmentIds.contains(s.id) || !s.isUploaded,
    );

    if (!hasAudioToSend) {
      // Nothing to send. Resuming a finished note is undone instead of
      // reprocessed; a new note waits for audio.
      final isResume = current.priorDurationMs > 0;
      if (isResume && segments.isEmpty) {
        _produce(services, (notes) => notes.localNoteById.remove(id));
      } else {
        _setRecorderFields(
          services,
          id,
          _RecorderFields(
            segments: segments,
            phase: isResume ? LocalNotePhase.ready : LocalNotePhase.paused,
          ),
        );
        if (!isResume) {
          showSnackbar(
            'No audio was recorded yet. Resume recording or delete the note.',
          );
        }
      }
      await _persist(services);
      return false;
    }

    _setRecorderFields(
      services,
      id,
      _RecorderFields(segments: segments, phase: current.phase),
    );
    _transition(services, id, LocalNoteEvent.stop);
    await _persist(services);
    unawaited(_syncLocalNote(services, id, isUserInitiated: true));
    return true;
  } finally {
    releaseKeepAlive();
  }
}
