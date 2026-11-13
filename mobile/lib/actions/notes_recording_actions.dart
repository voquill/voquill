part of 'notes_actions.dart';

// Recording lifecycle: start, pause, resume, stop and native recorder events.
// Every command runs through one queue per user session and re-reads the
// note after each await, so overlapping taps and native events can never
// act on a stale copy.

/// Segments roll over well below the server's 4-hour segment cap and its
/// smallest (free plan, 120 MB) byte cap.
const noteMaxSegmentDuration = Duration(hours: 2);
const noteMaxSegmentBytes = 100 * 1000 * 1000;

/// Recording stops before the server's 8-hour note cap.
const noteMaxDuration = Duration(hours: 7, minutes: 50);
const noteMaxSegments = 50;

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
    getAppState().notes.capturingNote?.phase == LocalNotePhase.recording;

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

/// Adopts what the native recorder reports: a rolled-over segment is added,
/// the previous one closed, and the phase follows pause/resume.
Future<LocalNote> _withNativeState(
  NotesServices services,
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
      final closed = await _closeSegment(services.store, note.id, segment);
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
  final draft = note.draft()
    ..segments = segments
    ..phase = native.isPaused ? LocalNotePhase.paused : LocalNotePhase.recording
    ..recordingStartedAt = native.isPaused
        ? null
        : DateTime.now().toUtc().toIso8601String();
  return draft.save();
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

Future<LocalNote> _closeOpenSegments(
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
  return (note.draft()
        ..segments = segments
        ..recordingStartedAt = null)
      .save();
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
  final adopted = await _withNativeState(services, note, state);
  if (!(_localOf(services, state.noteId)?.isCapturing ?? false)) return;
  _putLocal(services, adopted);
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
    case null:
      break;
  }
}

/// Why [note] cannot take another recording run, or null when it can.
String? _recordingLimitMessage(NotesServices services, LocalNote note) {
  final elapsed = note.elapsedMs(DateTime.now());
  final remainingMs = noteMaxDuration.inMilliseconds - elapsed;
  if (remainingMs <= const Duration(minutes: 1).inMilliseconds) {
    return _noteLimitMessage;
  }
  final localIds = note.segments.map((s) => s.id).toSet();
  final serverOnly =
      (_notesOf(services)?.noteById[note.id]?.segments ?? const [])
          .where((s) => !localIds.contains(s.id))
          .length;
  final rollovers = (remainingMs / noteMaxSegmentDuration.inMilliseconds)
      .ceil();
  if (note.segments.length + serverOnly + rollovers > noteMaxSegments) {
    return _tooManySegmentsMessage;
  }
  return null;
}

/// Checks everything a new recording run needs. [note] is the note about
/// to record (null for a brand-new one).
Future<bool> _ensureCanRecord(NotesServices services, LocalNote? note) async {
  final capturing = _notesOf(services)?.capturingNote;
  if (capturing != null && capturing.id != note?.id) {
    showSnackbar('Finish your current meeting before starting another one.');
    return false;
  }
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
    if (!await _startSegment(services, note, previous: null, index: 0)) {
      return null;
    }
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
      return _startSegment(
        services,
        local,
        previous: local,
        index: _nextSegmentIndex(services, local),
      );
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
    return _startSegment(
      services,
      note,
      previous: null,
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

/// Persists a new open segment, then starts the native recorder on it. On
/// failure the note goes back to [previous] (or disappears if it was new);
/// only the new, empty file is removed.
Future<bool> _startSegment(
  NotesServices services,
  LocalNote note, {
  required LocalNote? previous,
  required int? index,
}) async {
  final phase = previous == null
      ? LocalNotePhase.recording
      : nextLocalNotePhase(previous.phase, LocalNoteEvent.resume);
  if (phase == null) return false;

  final segmentId = const Uuid().v4();
  final segment = LocalNoteSegment(
    id: segmentId,
    fileName: '$segmentId.aac',
    index: index,
    isOpen: true,
  );
  final file = services.store.segmentFile(note.id, segment.fileName);
  await file.parent.create(recursive: true);

  final priorElapsedMs = note.elapsedMs(DateTime.now());
  final started =
      (note.draft()
            ..segments = [...note.segments, segment]
            ..phase = phase
            ..recordingStartedAt = DateTime.now().toUtc().toIso8601String()
            ..error = null)
          .save();
  if (!_isCurrent(services)) return false;
  _putLocal(services, started);
  await _persist(services);

  try {
    await services.recorder.start(
      noteId: note.id,
      segmentId: segmentId,
      path: file.path,
      priorElapsedMs: priorElapsedMs,
      maxSegmentMs: noteMaxSegmentDuration.inMilliseconds,
      maxSegmentBytes: noteMaxSegmentBytes,
      maxNoteMs: noteMaxDuration.inMilliseconds,
    );
    return true;
  } on PlatformException catch (e) {
    _logger.e('Failed to start recording: ${e.code}');
    _produce(services, (notes) {
      if (previous == null) {
        notes.localNoteById.remove(note.id);
      } else {
        notes.localNoteById[note.id] = previous.draft();
      }
    });
    await _persist(services);
    await services.store.deleteSegmentFile(note.id, segment.fileName);
    _showRecorderError(e);
    return false;
  }
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
      NoteRecorderState? resumed;
      try {
        resumed = await services.recorder.resume();
      } on PlatformException catch (e) {
        _showRecorderError(e);
        return;
      }
      final current = _localOf(services, id);
      if (resumed == null || current == null) return;
      _putLocal(services, await _withNativeState(services, current, resumed));
      await _persist(services);
      return;
    }
    if (!await _ensureCanRecord(services, note)) return;
    final current = _localOf(services, id);
    if (current?.phase != LocalNotePhase.paused) return;
    final closed = await _closeOpenSegments(services.store, current!);
    await _startSegment(
      services,
      closed,
      previous: closed,
      index: _nextSegmentIndex(services, closed),
    );
  });
}

/// Finishes the meeting and queues it for upload and processing.
Future<void> stopRecording(String id) async {
  final services = _services;
  if (services == null) return;
  await _recorderCommand(services, () async {
    if (!(_localOf(services, id)?.isCapturing ?? false)) return;
    try {
      final native = await services.recorder.getState();
      if (native?.noteId == id) await services.recorder.stop();
    } on PlatformException catch (e) {
      _logger.w('Stop failed: ${e.code}');
    }

    final note = _localOf(services, id);
    if (note == null) return;
    final runSegmentIds = note.segments
        .where((s) => s.isOpen)
        .map((s) => s.id)
        .toSet();
    final closed = await _closeOpenSegments(services.store, note);
    if (_localOf(services, id) == null) return;
    final hasNewAudio = closed.segments.any(
      (s) => runSegmentIds.contains(s.id),
    );

    if (!hasNewAudio) {
      // Nothing was captured in this run. Resuming a finished note is
      // undone instead of reprocessed; a new note waits for audio.
      final isResume = closed.priorDurationMs > 0;
      if (isResume && closed.segments.isEmpty) {
        _produce(services, (notes) => notes.localNoteById.remove(id));
      } else {
        _putLocal(
          services,
          (closed.draft()
                ..phase = isResume
                    ? LocalNotePhase.ready
                    : LocalNotePhase.paused)
              .save(),
        );
        if (!isResume) {
          showSnackbar(
            'No audio was recorded yet. Resume recording or delete the note.',
          );
        }
      }
      await _persist(services);
      return;
    }

    _putLocal(services, closed);
    _transition(services, id, LocalNoteEvent.stop);
    await _persist(services);
    unawaited(syncLocalNote(id, isUserInitiated: true));
  });
}
