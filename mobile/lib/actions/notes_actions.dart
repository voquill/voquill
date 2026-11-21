import 'dart:async';
import 'dart:io';
import 'dart:math';

import 'package:app/actions/remote_actions.dart';
import 'package:app/actions/revenue_cat_actions.dart';
import 'package:app/actions/snackbar_actions.dart';
import 'package:app/api/local_note_store.dart';
import 'package:app/api/note_recorder_api.dart';
import 'package:app/api/notes_api.dart';
import 'package:app/flavor.dart';
import 'package:app/model/common_model.dart';
import 'package:app/model/local_note_model.dart';
import 'package:app/model/note_model.dart';
import 'package:app/state/notes_state.dart';
import 'package:app/state/snackbar_state.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/adts_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:app/utils/member_utils.dart';
import 'package:app/utils/note_lifecycle_utils.dart';
import 'package:app/utils/note_utils.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:flutter/services.dart';
import 'package:path/path.dart' as p;
import 'package:path_provider/path_provider.dart';
import 'package:permission_handler/permission_handler.dart';
import 'package:uuid/uuid.dart';

part 'notes_recording_actions.dart';
part 'notes_sync_actions.dart';
part 'notes_library_actions.dart';

final _logger = createNamedLogger('notes_actions');

const _pageSize = 50;

/// Everything Notes needs for one signed-in user. Every async step keeps the
/// instance it started with and stops touching state once it is no longer
/// current (sign-out or account switch), so one user's work can never land
/// in another user's notes, cache or requests.
class NotesServices {
  NotesServices({
    required this.api,
    required this.store,
    required this.recorder,
    this.pollInterval = const Duration(seconds: 4),
    this.slowPollInterval = const Duration(seconds: 30),
    this.slowPollAfter = const Duration(minutes: 5),
    this.reprocessAfter = const Duration(minutes: 10),
    this.listPollInterval = const Duration(seconds: 15),
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

  /// Polling cadence from the contract: every few seconds, 30 s after five
  /// minutes; `process` is sent again when a note stays processing for ten
  /// minutes (the server's staleness window).
  final Duration pollInterval;
  final Duration slowPollInterval;
  final Duration slowPollAfter;
  final Duration reprocessAfter;

  /// How often the list is refreshed while a note processes off-screen.
  final Duration listPollInterval;

  /// Backoff for automatic retries after transient failures; empty disables
  /// them (tests drive retries explicitly).
  final List<Duration> retryDelays;

  Timer? _retryTimer;
  int _retryAttempt = 0;
  Timer? _editFlushTimer;
  StreamSubscription<NoteRecorderEvent>? _recorderSubscription;
  final _syncs = <String, Future<void>>{};
  final _watchingIds = <String>{};

  /// When this session last sent `process` per note; absent after a launch.
  final _lastProcessAt = <String, DateTime>{};

  /// Notes whose screen is open; only these poll `GET /v1/notes/:id`.
  final _openNoteIds = <String>{};
  Future<void>? _listRefresh;
  DateTime? _lastListRefreshAt;

  /// Serializes start/pause/resume/stop and native recorder events.
  Future<void> _recorderCommands = Future.value();
  int _activeUploads = 0;
}

NotesServices? _services;
int _initGeneration = 0;
final _openNoteRequests = StreamController<String>.broadcast();

/// Note ids the UI should open (Live Activity / notification taps).
Stream<String> get openNoteRequests => _openNoteRequests.stream;

bool _isCurrent(NotesServices services) => identical(_services, services);

/// Notes state of [services]' user, or null once that user is gone.
NotesState? _notesOf(NotesServices services) =>
    _isCurrent(services) ? getAppState().notes : null;

LocalNote? _localOf(NotesServices services, String id) =>
    _notesOf(services)?.localNoteById[id];

void _produce(
  NotesServices services,
  void Function(NotesStateDraft notes) update,
) {
  if (!_isCurrent(services)) return;
  produceAppState((draft) => update(draft.notes));
}

Future<void> _persist(NotesServices services) async {
  final notes = _notesOf(services);
  if (notes == null) return;
  await services.store.saveSnapshot(
    LocalNotesSnapshot(
      localNotes: notes.localNoteById.values.toList(),
      pendingEdits: notes.pendingEditById,
      pendingDeleteIds: notes.pendingDeleteIds,
    ),
  );
}

Future<void> _saveCache(NotesServices services) async {
  final notes = _notesOf(services);
  if (notes == null) return;
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
  NotesServices services,
  String id,
  LocalNoteEvent event, [
  void Function(LocalNoteDraft note)? update,
]) {
  var applied = false;
  _produce(services, (notes) {
    final note = notes.localNoteById[id];
    if (note == null) return;
    final next = nextLocalNotePhase(note.phase, event);
    if (next == null) return;
    note.phase = next;
    update?.call(note);
    applied = true;
  });
  if (!applied && _localOf(services, id) != null) {
    _logger.w(
      'Ignored ${event.name} for note in ${_localOf(services, id)?.phase}',
    );
  }
  return applied;
}

void _updateLocal(
  NotesServices services,
  String id,
  void Function(LocalNoteDraft note) update,
) {
  _produce(services, (notes) {
    final note = notes.localNoteById[id];
    if (note != null) update(note);
  });
}

void _putLocal(NotesServices services, LocalNote note) {
  _produce(services, (notes) => notes.localNoteById[note.id] = note.draft());
}

void _setSyncStatus(NotesServices services, String id, NoteSyncStatus? status) {
  _produce(services, (notes) {
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

void _storeServerNoteFor(NotesServices services, Note note) {
  _produce(services, (notes) => _storeServerNote(notes, note));
}

/// Thrown inside a sync when the note disappeared (deleted, signed out), to
/// unwind without touching anything.
class _NoteGone implements Exception {
  const _NoteGone();
}

LocalNote _requireLocal(NotesServices services, String id) =>
    _localOf(services, id) ?? (throw const _NoteGone());

void _setReachable(NotesServices services, bool isReachable) {
  if (_notesOf(services)?.isOffline != isReachable) return;
  _produce(services, (notes) => notes.isOffline = !isReachable);
}

/// Remembers Ask's daily limit so every Ask box says when it comes back.
void noteAskFailed(NotesApiException error) {
  final services = _services;
  if (services == null || error.code != 'ask_limit_exceeded') return;
  final resetsAt = error.details?['resetsAt'] as String?;
  final retryAfter = error.retryAfterSeconds;
  final availableAt =
      resetsAt ??
      DateTime.now()
          .add(Duration(seconds: retryAfter ?? 3600))
          .toUtc()
          .toIso8601String();
  _produce(services, (notes) => notes.askAvailableAt = availableAt);
}

/// A plan upgrade only helps free members (pro limits are the ceiling).
bool canUpgradeFor(NoteError? error) =>
    isQuotaError(error) &&
    getEffectivePlan(getAppState()) == EffectivePlan.free;

void offerUpgradeFor(NoteError? error) {
  if (canUpgradeFor(error)) presentPaywall();
}

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

final _noteRecorder = NoteRecorder();

/// Starts Notes for the signed-in user. Each user's local notes live in their
/// own directory (excluded from backups), and the token getter refuses to
/// answer for anyone else.
Future<void> initializeNotesForUser(String uid) async {
  final generation = ++_initGeneration;
  final support = await getApplicationSupportDirectory();
  if (generation != _initGeneration) return;
  final root = Directory(p.join(support.path, 'notes', uid));
  try {
    await _noteRecorder.excludeFromBackup(root.path);
  } on PlatformException catch (e) {
    _logger.w('Could not exclude notes from backups', e);
  }
  if (generation != _initGeneration) return;
  late final NotesServices services;
  services = NotesServices(
    api: NotesApi(
      baseUrl: Flavor.current.apiBaseUrl,
      getIdToken: ({bool forceRefresh = false}) async {
        final user = FirebaseAuth.instance.currentUser;
        if (user == null || user.uid != uid) return null;
        return user.getIdToken(forceRefresh);
      },
      onReachabilityChanged: (isReachable) =>
          _setReachable(services, isReachable),
    ),
    store: LocalNoteStore(root),
    recorder: _noteRecorder,
  );
  await initializeNotes(services, generation: generation);
}

Future<void> initializeNotes(NotesServices services, {int? generation}) async {
  await disposeNotes(keepGeneration: generation != null);
  final current = generation ?? ++_initGeneration;
  bool isStale() => current != _initGeneration;

  // Subscribe before reading the recorder state so no event is missed;
  // events queue behind initialization and are applied once notes load.
  final loaded = Completer<void>();
  services._recorderCommands = loaded.future;
  services._recorderSubscription = services.recorder.events.listen(
    (event) => _onRecorderEvent(services, event),
  );
  try {
    await _loadNotes(services, isStale);
  } finally {
    loaded.complete();
  }
  if (!_isCurrent(services)) return;

  NoteRecorderActionEvent? pending;
  try {
    pending = await services.recorder.takePendingAction();
  } catch (e) {
    _logger.w('Could not read pending recorder action', e);
  }
  if (pending != null) _onRecorderEvent(services, pending);

  unawaited(refreshNotes());
  unawaited(syncAllNotes());
}

Future<void> _loadNotes(NotesServices services, bool Function() isStale) async {
  final store = services.store;
  LocalNotesSnapshot snapshot;
  try {
    snapshot = await store.loadSnapshot();
  } catch (e) {
    _logger.e('Local notes snapshot is unreadable; recovering from disk', e);
    await store.quarantineSnapshot();
    snapshot = const LocalNotesSnapshot();
  }
  List<Note> cached;
  try {
    cached = await store.loadCachedNotes();
  } catch (e) {
    _logger.w('Notes cache is unreadable', e);
    cached = const [];
  }
  NoteRecorderState? native;
  try {
    native = await services.recorder.getState();
  } catch (e) {
    _logger.w('Could not read recorder state', e);
  }
  if (isStale()) return;

  _services = services;
  final localNotes = <LocalNote>[];
  for (final note in snapshot.localNotes) {
    localNotes.add(await _reenterAfterRestart(store, note, native));
  }
  final recovered = await _adoptOrphanFiles(store, localNotes, native);

  // The note the recorder is still writing gets its current segment last,
  // after any files it rolled over to while the app was gone.
  String? recorderNoteId;
  if (native != null) {
    final index = recovered.indexWhere(
      (n) => n.id == native!.noteId && n.isCapturing,
    );
    if (index < 0) {
      await _stopRecorderQuietly(services);
    } else {
      final note = recovered[index];
      final fields = await _nativeFields(store, note, native);
      recovered[index] =
          (note.draft()
                ..segments = fields.segments
                ..phase = fields.phase
                ..recordingStartedAt = fields.recordingStartedAt)
              .save();
      recorderNoteId = note.id;
    }
  }
  if (!_isCurrent(services)) return;

  _produce(services, (notes) {
    notes.localNoteById = {for (final n in recovered) n.id: n};
    notes.pendingEditById = snapshot.pendingEdits;
    notes.pendingDeleteIds = snapshot.pendingDeleteIds;
    notes.noteById = {for (final n in cached) n.id: n};
    notes.serverNoteIds = cached.map((n) => n.id).toList();
    notes.recorderNoteId = recorderNoteId;
    notes.isInitialized = true;
  });
  await _persist(services);
}

Future<LocalNote> _reenterAfterRestart(
  LocalNoteStore store,
  LocalNote note,
  NoteRecorderState? native,
) async {
  if (note.isCapturing && native?.noteId == note.id) return note;
  final phase = phaseAfterRestart(note.phase, isRecorderActive: false);
  if (!note.isCapturing) return (note.draft()..phase = phase).save();
  return (note.draft()
        ..segments = await _closedSegments(store, note)
        ..recordingStartedAt = null
        ..phase = phase)
      .save();
}

/// Audio on disk that no local note references (an unreadable snapshot, a
/// crash between creating a file and saving it, rollovers while the app was
/// gone) joins its note, in recording order, or becomes a new paused note.
/// The file the recorder is writing is left alone, and nothing is deleted
/// in its note's directory: a file it just opened is still empty.
Future<List<LocalNote>> _adoptOrphanFiles(
  LocalNoteStore store,
  List<LocalNote> localNotes,
  NoteRecorderState? native,
) async {
  final byId = {for (final n in localNotes) n.id: n};
  final filesByNote = await store.listNoteFiles();
  for (final MapEntry(key: noteId, value: files) in filesByNote.entries) {
    final note = byId[noteId];
    final isRecorderNote = native?.noteId == noteId;
    final referenced = {
      ...?note?.segments.map((s) => s.fileName),
      if (isRecorderNote) '${native!.segmentId}.aac',
    };
    final orphans = <({File file, DateTime modified})>[];
    for (final file in files) {
      final name = p.basename(file.path);
      if (LocalNoteStore.isImportFile(file)) {
        if (note == null) {
          byId[noteId] = LocalNote(
            id: noteId,
            source: NoteSource.imported,
            title: _importDefaultTitle,
            createdAt: (await file.lastModified()).toUtc().toIso8601String(),
            phase: LocalNotePhase.pendingUpload,
          );
        }
        continue;
      }
      if (!name.endsWith('.aac') || referenced.contains(name)) continue;
      if (await file.length() < adtsHeaderLength) {
        if (!isRecorderNote) await file.delete();
        continue;
      }
      orphans.add((file: file, modified: await file.lastModified()));
    }
    if (orphans.isEmpty) continue;
    orphans.sort((a, b) => a.modified.compareTo(b.modified));
    _logger.w('Recovered ${orphans.length} unreferenced audio files');

    final existing = note?.segments ?? const <LocalNoteSegment>[];
    var nextIndex = existing.isEmpty ? 0 : _nextLocalIndex(existing);
    final adopted = <LocalNoteSegment>[];
    for (final orphan in orphans) {
      final name = p.basename(orphan.file.path);
      adopted.add(
        LocalNoteSegment(
          id: p.basenameWithoutExtension(name),
          fileName: name,
          index: nextIndex,
          durationMs: await readAdtsDurationMs(orphan.file),
        ),
      );
      if (nextIndex != null) nextIndex++;
    }
    byId[noteId] = note != null
        ? (note.draft()..segments = [...existing, ...adopted]).save()
        : LocalNote(
            id: noteId,
            title: 'Recovered recording',
            createdAt: orphans.first.modified.toUtc().toIso8601String(),
            phase: LocalNotePhase.paused,
            segments: adopted,
          );
  }
  return byId.values.toList();
}

/// Ends the current user's Notes session: timers stop, requests are
/// aborted, and any work still running for them stops touching state.
Future<void> disposeNotes({bool keepGeneration = false}) async {
  if (!keepGeneration) _initGeneration++;
  final services = _services;
  _services = null;
  if (services == null) {
    produceAppState((draft) => draft.notes = const NotesState());
    return;
  }
  services._retryTimer?.cancel();
  services._editFlushTimer?.cancel();
  await services._recorderSubscription?.cancel();
  if (getAppState().notes.recorderNoteId != null) {
    await _stopRecorderQuietly(services);
  }
  services.api.close();
  await services.store.flush();
  produceAppState((draft) => draft.notes = const NotesState());
}

Future<void> _stopRecorderQuietly(NotesServices services) async {
  try {
    await services.recorder.stop();
  } catch (e) {
    _logger.w('Failed to stop recorder', e);
  }
}
