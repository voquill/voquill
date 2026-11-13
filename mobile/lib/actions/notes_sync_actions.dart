part of 'notes_actions.dart';

// Sync engine: the finish flow (PUT → upload each segment → process → poll →
// store the result → delete transcribed audio), retries, and server-side
// actions on notes without a local copy.

/// Runs the finish flow for one local note from whatever step it is at.
/// Every step is idempotent, so a crash or failure at any point is retried
/// from the persisted state.
Future<void> syncLocalNote(String id, {bool isUserInitiated = false}) {
  final services = _services;
  if (services == null) return Future.value();
  return _syncLocalNote(services, id, isUserInitiated: isUserInitiated);
}

Future<void> _syncLocalNote(
  NotesServices services,
  String id, {
  bool isUserInitiated = false,
}) {
  return services._syncs[id] ??=
      _runSyncGuarded(
        services,
        id,
        isUserInitiated: isUserInitiated,
      ).whenComplete(() {
        services._syncs.remove(id);
      });
}

Future<void> _runSyncGuarded(
  NotesServices services,
  String id, {
  required bool isUserInitiated,
}) async {
  try {
    await _runSync(services, id);
    services._retryAttempt = 0;
  } on _NoteGone {
    return;
  } on NotesApiException catch (e) {
    if (!_isCurrent(services)) return;
    await _handleSyncFailure(services, id, e, isUserInitiated: isUserInitiated);
  } catch (e, stack) {
    if (!_isCurrent(services)) return;
    _logger.e('Note sync failed', e, stack);
    _transition(
      services,
      id,
      LocalNoteEvent.fail,
      (note) => note.error = const NoteError(
        code: 'client_error',
        message: 'Something went wrong on this device.',
      ),
    );
  } finally {
    _produce(services, (notes) {
      notes.syncById[id]?.uploadProgress = null;
    });
    await _persist(services);
  }
}

Future<void> _handleSyncFailure(
  NotesServices services,
  String id,
  NotesApiException e, {
  required bool isUserInitiated,
}) async {
  _logger.w('Note sync stopped: ${e.code} (${e.statusCode})');
  if (e.isNoteDeleted) {
    await _recoverDeletedNote(services, id);
    return;
  }
  if (e.isTransient) {
    if (_localOf(services, id)?.phase == LocalNotePhase.uploading) {
      _transition(services, id, LocalNoteEvent.uploadInterrupted);
    }
    _setSyncStatus(
      services,
      id,
      NoteSyncStatus(isWaitingForConnection: e.isNetwork, isQueued: e.isQueued),
    );
    _scheduleRetry(services, after: e.retryAfterSeconds);
    return;
  }
  if (e.isNoteNotFound) {
    // Deleted on another device: Retry recreates it from the local audio.
    _updateLocal(services, id, (note) {
      note.existsOnServer = false;
      for (final segment in note.segments) {
        segment.isUploaded = false;
        segment.uploadUrl = null;
        segment.uploadSizeBytes = null;
      }
    });
  }
  _transition(
    services,
    id,
    LocalNoteEvent.fail,
    (note) => note.error = e.toNoteError(),
  );
  if (isUserInitiated) offerUpgradeFor(e.toNoteError());
}

/// The id was deleted (on another device) and the server reserves it, so the
/// note cannot be recreated. Audio the server never got is kept as a new
/// "Recovered recording" under a fresh id; anything else goes.
Future<void> _recoverDeletedNote(NotesServices services, String id) async {
  final note = _localOf(services, id);
  if (note == null) return;
  if (note.source == NoteSource.imported || note.segments.isEmpty) {
    _produce(services, (notes) {
      notes.localNoteById.remove(id);
      notes.syncById.remove(id);
      notes.pendingEditById.remove(id);
    });
    await _persist(services);
    await services.store.deleteNoteFiles(id);
    showSnackbar('This note was deleted on another device.');
    return;
  }
  final newId = const Uuid().v4();
  await services.store.moveNoteFiles(id, newId);
  final recovered = LocalNote(
    id: newId,
    title: 'Recovered recording',
    personalNotes: note.personalNotes,
    createdAt: note.createdAt,
    phase: LocalNotePhase.paused,
    segments: [
      for (final (index, segment) in note.segments.indexed)
        LocalNoteSegment(
          id: segment.id,
          fileName: segment.fileName,
          index: index,
          durationMs: segment.durationMs,
        ),
    ],
  );
  _produce(services, (notes) {
    notes.localNoteById.remove(id);
    notes.syncById.remove(id);
    notes.pendingEditById.remove(id);
    notes.localNoteById[newId] = recovered.draft();
  });
  await _persist(services);
  showSnackbar(
    'This note was deleted on another device. Its recording that had not been sent yet is kept as "Recovered recording".',
  );
}

Future<void> _runSync(NotesServices services, String id) async {
  final note = _requireLocal(services, id);
  _setSyncStatus(services, id, const NoteSyncStatus());

  if (note.phase == LocalNotePhase.pendingUpload ||
      note.phase == LocalNotePhase.uploading) {
    _transition(services, id, LocalNoteEvent.startUpload);
    final server = await _whileUploading(
      services,
      () => note.source == NoteSource.imported
          ? _sendImport(services, note)
          : _uploadAndProcess(services, id),
    );
    _requireLocal(services, id);
    _storeServerNoteFor(services, server);
    _transition(services, id, LocalNoteEvent.processAccepted, (n) {
      n.existsOnServer = true;
      n.error = null;
    });
    _setSyncStatus(services, id, null);
    await _persist(services);
  }

  if (_localOf(services, id)?.phase == LocalNotePhase.processing) {
    await _pollLocalNote(services, id);
  }

  if (_localOf(services, id)?.phase == LocalNotePhase.ready) {
    await _finalizeReadyNote(services, id);
  }
}

/// Keeps the process alive (iOS background task, Android data-sync service)
/// while audio or an import is being sent; polling does not need it.
Future<T> _whileUploading<T>(
  NotesServices services,
  Future<T> Function() send,
) async {
  if (services._activeUploads++ == 0) {
    unawaited(services.recorder.setSyncActive(true).catchError((_) {}));
  }
  try {
    return await send();
  } finally {
    if (--services._activeUploads == 0) {
      unawaited(services.recorder.setSyncActive(false).catchError((_) {}));
    }
  }
}

String? _userTitle(LocalNote note) =>
    note.titleSource == NoteTitleSource.user ? note.title : null;

Future<Note> _sendImport(NotesServices services, LocalNote note) async {
  final transcript = await services.store.importFile(note.id).readAsString();
  services._lastProcessAt[note.id] = DateTime.now();
  return services.api.importNote(
    id: note.id,
    transcript: transcript,
    title: _userTitle(note),
    personalNotes: note.personalNotes.isEmpty ? null : note.personalNotes,
    createdAt: note.createdAt,
  );
}

/// `process` with the latest My notes (and the title only if the user set
/// it, so an AI title can still replace a default one).
Future<Note> _processLocalNote(NotesServices services, String id) {
  final note = _requireLocal(services, id);
  services._lastProcessAt[id] = DateTime.now();
  return note.source == NoteSource.imported
      ? _sendImport(services, note)
      : services.api.processNote(
          id,
          title: _userTitle(note),
          personalNotes: note.personalNotes,
        );
}

/// Idempotent `PUT` creating the note; a no-op once the server has it.
Future<void> _putNote(NotesServices services, String id) async {
  final note = _requireLocal(services, id);
  if (note.existsOnServer) return;
  await services.api.putNote(
    id,
    title: note.titleSource == NoteTitleSource.ai ? null : note.title,
    titleSource: note.titleSource,
    personalNotes: note.personalNotes,
    createdAt: note.createdAt,
  );
  _updateLocal(services, id, (n) => n.existsOnServer = true);
  await _persist(services);
}

/// Creates the note while recording so My notes edits sync right away;
/// offline it is sent again by [syncAllNotes] or at Stop.
Future<void> _createOnServer(NotesServices services, String id) async {
  try {
    await _putNote(services, id);
  } on NotesApiException catch (e) {
    _logger.w('Note not created on server yet: ${e.code}');
  } on _NoteGone {
    return;
  }
}

Future<Note> _uploadAndProcess(NotesServices services, String id) async {
  await _putNote(services, id);
  for (var attempt = 0; ; attempt++) {
    await _uploadSegments(services, id);
    try {
      return await _processLocalNote(services, id);
    } on NotesApiException catch (e) {
      final missing = (e.details?['segmentIds'] as List?)?.cast<String>();
      if (e.code != 'audio_missing' || missing == null || attempt > 0) rethrow;
      _markForUpload(services, id, missing.contains);
      await _persist(services);
    }
  }
}

void _markForUpload(
  NotesServices services,
  String id,
  bool Function(String segmentId) test,
) {
  _updateLocal(services, id, (n) {
    for (final segment in n.segments.where((s) => test(s.id))) {
      segment.isUploaded = false;
      segment.uploadUrl = null;
      segment.uploadSizeBytes = null;
    }
  });
}

Future<void> _uploadSegments(NotesServices services, String id) async {
  final pending = _requireLocal(
    services,
    id,
  ).segments.where((s) => !s.isUploaded && !s.isOpen).toList();
  final sizes = <String, int>{};
  for (final segment in pending) {
    final file = services.store.segmentFile(id, segment.fileName);
    if (await file.exists()) {
      sizes[segment.id] = await file.length();
    } else {
      await _dropMissingSegment(services, id, segment);
    }
  }
  if (_requireLocal(services, id).segments.isEmpty) {
    throw const NotesApiException(
      statusCode: 409,
      code: 'no_audio',
      message: 'No audio is left for this note.',
    );
  }
  final totalBytes = max(1, sizes.values.fold<int>(0, (a, b) => a + b));
  var doneBytes = 0;

  void reportProgress(int bytes) {
    _setSyncStatus(
      services,
      id,
      NoteSyncStatus(uploadProgress: (bytes / totalBytes).clamp(0.0, 1.0)),
    );
  }

  for (final segment in pending) {
    final size = sizes[segment.id];
    if (size == null) continue;
    await _uploadSegment(
      services,
      id,
      segment.id,
      size,
      onProgress: (sent) => reportProgress(doneBytes + sent),
    );
    doneBytes += size;
    reportProgress(doneBytes);
    _updateLocal(services, id, (n) {
      for (final s in n.segments.where((s) => s.id == segment.id)) {
        s.isUploaded = true;
      }
    });
    await _persist(services);
  }
}

/// A segment whose file is gone can never be uploaded: drop it here and on
/// the server so the rest of the note still processes.
Future<void> _dropMissingSegment(
  NotesServices services,
  String id,
  LocalNoteSegment segment,
) async {
  _logger.w('Segment audio file is missing; dropping the segment');
  if (_requireLocal(services, id).existsOnServer) {
    try {
      await services.api.deleteSegment(id, segment.id);
    } on NotesApiException catch (e) {
      if (!e.isNoteNotFound) rethrow;
    }
  }
  _updateLocal(services, id, (n) {
    n.segments = n.segments.where((s) => s.id != segment.id).toList();
  });
  await _persist(services);
}

/// Resumes the persisted upload session when it still matches the file; a
/// session that expired, was refused or was made for a different size
/// starts over with a new one.
Future<void> _uploadSegment(
  NotesServices services,
  String noteId,
  String segmentId,
  int size, {
  required void Function(int sentBytes) onProgress,
}) async {
  LocalNoteSegment current() =>
      _requireLocal(services, noteId).segments.firstWhere(
        (s) => s.id == segmentId,
        orElse: () => throw const _NoteGone(),
      );

  for (var attempt = 0; ; attempt++) {
    try {
      var uploadUrl = current().uploadUrl;
      if (uploadUrl != null && current().uploadSizeBytes != size) {
        uploadUrl = null;
      }
      var offset = 0;
      if (uploadUrl != null) {
        offset = await services.api.queryUploadOffset(uploadUrl, size);
      } else {
        try {
          uploadUrl = await services.api.createSegmentUpload(
            noteId,
            segmentId,
            durationMs: current().durationMs,
            sizeBytes: size,
            index: current().index,
          );
        } on NotesApiException catch (e) {
          // Already transcribed, or accepted and being processed: either
          // way the server has this audio.
          if (e.code == 'segment_transcribed' || e.isSegmentProcessing) return;
          rethrow;
        }
        final url = uploadUrl;
        _updateLocal(services, noteId, (n) {
          for (final s in n.segments.where((s) => s.id == segmentId)) {
            s.uploadUrl = url;
            s.uploadSizeBytes = size;
          }
        });
        await _persist(services);
      }
      if (offset < size) {
        await services.api.uploadBytes(
          uploadUrl,
          services.store.segmentFile(noteId, current().fileName),
          offset: offset,
          totalBytes: size,
          onProgress: onProgress,
        );
      }
      return;
    } on NotesApiException catch (e) {
      if (e.isTransient) rethrow;
      // Any permanent session failure invalidates the URL.
      _markForUpload(services, noteId, (id) => id == segmentId);
      await _persist(services);
      if (!e.needsNewUploadSession || attempt > 0) rethrow;
    }
  }
}

/// Polls `GET /v1/notes/:id` while [isWanted] holds and the note is
/// processing; returns the last copy seen, or null when abandoned. Sends
/// [reprocess] when the note looks stale.
Future<Note?> _pollWhileProcessing(
  NotesServices services,
  String id, {
  required bool Function() isWanted,
  required Future<Note> Function() reprocess,
}) async {
  final startedAt = DateTime.now();
  while (isWanted()) {
    final lastProcess = services._lastProcessAt[id];
    if (lastProcess == null ||
        DateTime.now().difference(lastProcess) >= services.reprocessAfter) {
      services._lastProcessAt[id] = DateTime.now();
      final note = await reprocess();
      _storeServerNoteFor(services, note);
    }
    final note = await services.api.getNote(id);
    if (!isWanted()) return null;
    _storeServerNoteFor(services, note);
    if (note.status != NoteStatus.processing) return note;
    final isSlow =
        DateTime.now().difference(startedAt) >= services.slowPollAfter;
    await Future.delayed(
      isSlow ? services.slowPollInterval : services.pollInterval,
    );
  }
  return null;
}

Future<void> _pollLocalNote(NotesServices services, String id) async {
  while (true) {
    final note = await _pollWhileProcessing(
      services,
      id,
      isWanted: () =>
          _localOf(services, id)?.phase == LocalNotePhase.processing,
      reprocess: () => _processLocalNote(services, id),
    );
    switch (note?.status) {
      case null:
      case NoteStatus.processing:
        return;
      case NoteStatus.ready:
        _transition(services, id, LocalNoteEvent.serverReady);
        await _persist(services);
        _onNoteSettled(services);
        return;
      case NoteStatus.failed:
        _markSegmentsNeedingUpload(services, id, note!);
        _transition(
          services,
          id,
          LocalNoteEvent.fail,
          (n) => n.error =
              note.error ??
              const NoteError(code: 'internal_error', message: ''),
        );
        await _persist(services);
        _onNoteSettled(services);
        return;
      case NoteStatus.draft:
        services._lastProcessAt.remove(id);
    }
  }
}

/// A processing slot freed up: notes queued behind the plan's limit go now.
void _onNoteSettled(NotesServices services) {
  final queued = _notesOf(
    services,
  )?.syncById.entries.where((e) => e.value.isQueued).map((e) => e.key).toList();
  if (queued == null || queued.isEmpty) return;
  for (final id in queued) {
    unawaited(_syncLocalNote(services, id));
  }
}

/// Stored segment codes after which `process` skips the segment until it
/// is uploaded again (docs/notes.md, Job error codes); every other code is
/// retried by `process` alone.
const _reuploadErrorCodes = {
  'unsupported_audio',
  'audio_missing',
  'segment_too_large',
};

/// Segments the server cannot use as stored get uploaded again on Retry.
void _markSegmentsNeedingUpload(
  NotesServices services,
  String id,
  Note server,
) {
  final ids = (server.segments ?? const <NoteSegment>[])
      .where(
        (s) =>
            s.status == NoteSegmentStatus.failed &&
            _reuploadErrorCodes.contains(s.error?.code),
      )
      .map((s) => s.id)
      .toSet();
  _markForUpload(services, id, ids.contains);
}

/// The server finished: store the full result, then delete the audio of
/// every segment it transcribed, and only that. Segments that failed stay
/// on the device (the note remains `ready` locally) until a Retry succeeds
/// or the user removes them.
Future<void> _finalizeReadyNote(NotesServices services, String id) async {
  var server = _notesOf(services)?.noteById[id];
  if (server?.status != NoteStatus.ready || server?.segments == null) {
    server = await services.api.getNote(id);
    _storeServerNoteFor(services, server);
  }
  final ready = server!;
  if (ready.status != NoteStatus.ready) return;
  await _saveCache(services);

  final serverSegments = {for (final s in ready.segments!) s.id: s};
  final local = _requireLocal(services, id);
  final remaining = <LocalNoteSegment>[];
  for (final segment in local.segments) {
    if (serverSegments[segment.id]?.status == NoteSegmentStatus.transcribed) {
      await services.store.deleteSegmentFile(id, segment.fileName);
    } else {
      remaining.add(segment);
    }
  }
  if (local.source == NoteSource.imported) {
    await services.store.deleteImportTranscript(id);
  }
  final latest = _requireLocal(services, id);
  final keep = latest.segments
      .where((s) => remaining.any((r) => r.id == s.id) || s.isOpen)
      .toList();

  if (keep.isEmpty) {
    _produce(services, (notes) {
      notes.localNoteById.remove(id);
      notes.syncById.remove(id);
    });
    await _persist(services);
    return;
  }

  final failed = keep
      .map((s) => serverSegments[s.id])
      .whereType<NoteSegment>()
      .where((s) => s.status == NoteSegmentStatus.failed)
      .toList();
  _updateLocal(services, id, (n) {
    n.segments = keep;
    n.title = ready.title;
    n.titleSource = ready.titleSource;
    n.priorDurationMs =
        ready.durationMs - keep.fold(0, (sum, s) => sum + s.durationMs);
    n.error =
        failed.firstOrNull?.error ??
        const NoteError(code: 'internal_error', message: '');
  });
  _markSegmentsNeedingUpload(services, id, ready);
  await _persist(services);
  if (failed.length < keep.length) {
    // Audio the server never processed (e.g. recovered from disk): send it.
    _transition(services, id, LocalNoteEvent.retry);
    await _persist(services);
    unawaited(Future(() => _syncLocalNote(services, id)));
  }
}

/// Retries with backoff, or later if the server said when ([after], seconds).
void _scheduleRetry(NotesServices services, {int? after}) {
  final delays = services.retryDelays;
  if (delays.isEmpty || services._retryTimer?.isActive == true) return;
  final backoff = delays[min(services._retryAttempt, delays.length - 1)];
  final serverDelay = Duration(seconds: after ?? 0);
  final delay = serverDelay > backoff ? serverDelay : backoff;
  services._retryAttempt++;
  services._retryTimer = Timer(delay, () {
    if (_isCurrent(services)) unawaited(syncAllNotes());
  });
}

/// Flushes queued deletes and edits and resumes every unfinished note.
Future<void> syncAllNotes() async {
  final services = _services;
  if (services == null) return;
  services._retryTimer?.cancel();
  await _flushPendingDeletes(services);
  for (final note
      in _notesOf(services)?.localNoteById.values.toList() ??
          const <LocalNote>[]) {
    if (note.isCapturing) await _createOnServer(services, note.id);
  }
  await _flushPendingEdits(services);
  final ids =
      _notesOf(services)?.localNoteById.values
          .where((n) => localNoteNeedsSync(n.phase))
          .map((n) => n.id)
          .toList() ??
      const [];
  await Future.wait(ids.map((id) => _syncLocalNote(services, id)));
}

Future<void> retryNote(String id) async {
  final services = _services;
  if (services == null) return;
  if (_localOf(services, id) != null) {
    if (_transition(
      services,
      id,
      LocalNoteEvent.retry,
      (n) => n.error = null,
    )) {
      await _persist(services);
    }
    await _syncLocalNote(services, id, isUserInitiated: true);
    return;
  }
  await _runServerAction(services, () => services.api.processNote(id));
}

/// Removes the parts of a ready note that could not be transcribed: their
/// local audio and the server segments. The user chose this explicitly.
Future<void> dropFailedSegments(String id) async {
  final services = _services;
  final local = services == null ? null : _localOf(services, id);
  if (services == null ||
      local == null ||
      local.phase != LocalNotePhase.ready) {
    return;
  }
  try {
    for (final segment in local.segments) {
      await services.api.deleteSegment(id, segment.id);
    }
  } on NotesApiException catch (e) {
    showSnackbar(describeNoteError(e.toNoteError()), type: SnackbarType.error);
    return;
  }
  for (final segment in local.segments) {
    await services.store.deleteSegmentFile(id, segment.fileName);
  }
  _produce(services, (notes) {
    notes.localNoteById.remove(id);
    notes.syncById.remove(id);
  });
  await _persist(services);
  unawaited(loadNote(id));
}

Future<void> regenerateNote(String id) async {
  final services = _services;
  if (services == null) return;
  await _runServerAction(services, () => services.api.regenerateNote(id));
}

/// Starts server-side work on a note that has no local copy and follows it
/// until it settles. No automatic retry: the user asked for it just now.
Future<void> _runServerAction(
  NotesServices services,
  Future<Note> Function() action,
) async {
  try {
    final note = await action();
    services._lastProcessAt[note.id] = DateTime.now();
    _storeServerNoteFor(services, note);
    unawaited(watchServerNote(note.id));
  } on NotesApiException catch (e) {
    if (!_isCurrent(services)) return;
    offerUpgradeFor(e.toNoteError());
    showSnackbar(describeApiError(e), type: SnackbarType.error);
  }
}

/// Polls a server-only note while it is processing (regenerate, other device).
Future<void> watchServerNote(String id) async {
  final services = _services;
  if (services == null || !services._watchingIds.add(id)) return;
  try {
    await _pollWhileProcessing(
      services,
      id,
      isWanted: () =>
          _isCurrent(services) &&
          _localOf(services, id) == null &&
          !(_notesOf(services)?.pendingDeleteIds.contains(id) ?? true),
      reprocess: () => services.api.processNote(id),
    );
  } on NotesApiException catch (e) {
    _logger.w('Stopped watching note: ${e.code}');
  } finally {
    services._watchingIds.remove(id);
  }
}
