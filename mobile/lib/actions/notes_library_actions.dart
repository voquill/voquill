part of 'notes_actions.dart';

// The notes list, detail, search, Ask, import, edits and deletes.

const _importDefaultTitle = 'Imported transcript';

/// Bumped by every refresh so a slower "load more" from before it cannot
/// append a page from a stale cursor.
int _listGeneration = 0;

Future<void> refreshNotes() async {
  final services = _services;
  if (services == null) return;
  final generation = ++_listGeneration;
  _produce(services, (notes) => notes.listStatus = ActionStatus.loading);
  try {
    final page = await services.api.listNotes(limit: _pageSize);
    if (generation != _listGeneration) return;
    _produce(services, (notes) {
      for (final note in page.notes) {
        _storeServerNote(notes, note);
      }
      notes.serverNoteIds = page.notes.map((n) => n.id).toList();
      notes.nextCursor = page.nextCursor;
      notes.listStatus = ActionStatus.success;
      notes.loadMoreStatus = ActionStatus.idle;
    });
    await _saveCache(services);
  } on NotesApiException catch (e) {
    _logger.w('Failed to load notes: ${e.code}');
    _produce(services, (notes) => notes.listStatus = ActionStatus.error);
  }
}

/// Loads the next page. After a failure it waits for an explicit retry
/// ([retry]) instead of firing again on the next scroll.
Future<void> loadMoreNotes({bool retry = false}) async {
  final services = _services;
  final notes = services == null ? null : _notesOf(services);
  final cursor = notes?.nextCursor;
  if (services == null || notes == null || cursor == null) return;
  if (notes.loadMoreStatus.isLoading) return;
  if (notes.loadMoreStatus.isError && !retry) return;
  final generation = _listGeneration;
  _produce(services, (n) => n.loadMoreStatus = ActionStatus.loading);
  try {
    final page = await services.api.listNotes(limit: _pageSize, cursor: cursor);
    if (generation != _listGeneration) return;
    _produce(services, (n) {
      for (final note in page.notes) {
        _storeServerNote(n, note);
      }
      n.serverNoteIds = [
        ...n.serverNoteIds,
        ...page.notes
            .map((note) => note.id)
            .where((id) => !n.serverNoteIds.contains(id)),
      ];
      n.nextCursor = page.nextCursor;
      n.loadMoreStatus = ActionStatus.success;
    });
  } on NotesApiException catch (e) {
    _logger.w('Failed to load more notes: ${e.code}');
    if (generation != _listGeneration) return;
    _produce(services, (n) => n.loadMoreStatus = ActionStatus.error);
  }
}

/// Fetches the full note (segments and transcripts).
Future<void> loadNote(String id) async {
  final services = _services;
  if (services == null ||
      (_notesOf(services)?.pendingDeleteIds.contains(id) ?? true)) {
    return;
  }
  try {
    final note = await services.api.getNote(id);
    if (_notesOf(services)?.pendingDeleteIds.contains(id) ?? true) return;
    _storeServerNoteFor(services, note);
    if (note.status == NoteStatus.processing &&
        _localOf(services, id) == null) {
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
  _produce(services, (notes) {
    for (final result in results) {
      if (!notes.noteById.containsKey(result.note.id)) {
        notes.noteById[result.note.id] = result.note;
      }
    }
  });
  return _isCurrent(services) ? results : const [];
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
  _putLocal(services, note);
  await _persist(services);
  unawaited(_syncLocalNote(services, id, isUserInitiated: true));
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
  final services = _services;
  if (services == null) return;
  _produce(services, (notes) {
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
  await _persist(services);
  services._editFlushTimer?.cancel();
  services._editFlushTimer = Timer(
    const Duration(seconds: 2),
    () => _flushPendingEdits(services),
  );
}

Future<void> _flushPendingEdits(NotesServices services) async {
  final edits = _notesOf(services)?.pendingEditById.entries.toList();
  if (edits == null) return;
  for (final MapEntry(key: id, value: edit) in edits) {
    final local = _localOf(services, id);
    if (local != null && !local.existsOnServer) continue;
    try {
      final note = await services.api.patchNote(
        id,
        title: edit.title,
        personalNotes: edit.personalNotes,
      );
      _produce(services, (notes) {
        if (notes.noteById.containsKey(id)) _storeServerNote(notes, note);
        final current = notes.pendingEditById[id];
        if (current?.title == edit.title &&
            current?.personalNotes == edit.personalNotes) {
          notes.pendingEditById.remove(id);
        }
      });
    } on NotesApiException catch (e) {
      if (e.isTransient) {
        _scheduleRetry(services);
        break;
      }
      _logger.w('Dropping note edit: ${e.code}');
      _produce(services, (notes) => notes.pendingEditById.remove(id));
    }
  }
  await _persist(services);
}

/// Deletes the note everywhere. Local state goes at once; the server DELETE
/// waits for any sync still running for the note, so a late upload cannot
/// recreate it after the delete.
Future<void> deleteNote(String id) async {
  final services = _services;
  if (services == null) return;
  await _recorderCommand(services, () async {
    if (_localOf(services, id)?.isCapturing ?? false) {
      final native = await services.recorder.getState();
      if (native?.noteId == id) await _stopRecorderQuietly(services);
    }
  });
  _produce(services, (notes) {
    notes.localNoteById.remove(id);
    notes.noteById.remove(id);
    notes.serverNoteIds = notes.serverNoteIds.where((n) => n != id).toList();
    notes.pendingEditById.remove(id);
    notes.syncById.remove(id);
    if (!notes.pendingDeleteIds.contains(id)) {
      notes.pendingDeleteIds = [...notes.pendingDeleteIds, id];
    }
  });
  await _persist(services);
  await services.store.deleteNoteFiles(id);
  await _saveCache(services);
  final running = services._syncs[id];
  unawaited(
    (running ?? Future.value()).whenComplete(
      () => _flushPendingDeletes(services),
    ),
  );
}

Future<void> _flushPendingDeletes(NotesServices services) async {
  final ids = _notesOf(services)?.pendingDeleteIds.toList() ?? const [];
  for (final id in ids) {
    if (services._syncs.containsKey(id)) continue;
    try {
      await services.api.deleteNote(id);
    } on NotesApiException catch (e) {
      if (e.isTransient) {
        _scheduleRetry(services);
        return;
      }
      _logger.w('Server refused note delete: ${e.code}');
    }
    _produce(services, (notes) {
      notes.pendingDeleteIds = notes.pendingDeleteIds
          .where((n) => n != id)
          .toList();
    });
    await _persist(services);
  }
}
