import 'dart:async';

import 'package:app/actions/notes_actions.dart';
import 'package:app/actions/session_actions.dart';
import 'package:app/actions/snackbar_actions.dart';
import 'package:app/api/dictation_api.dart';
import 'package:app/model/session_history_entry.dart';
import 'package:app/state/remote_state.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/audio_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:app/utils/remote_utils.dart';
import 'package:firebase_auth/firebase_auth.dart';
import 'package:firebase_database/firebase_database.dart';
import 'package:record/record.dart';

final _logger = createNamedLogger('remote_actions');

enum DictationTarget { freeForm, activeTurn }

class _RemoteSessionRuntime {
  AudioRecorder? recorder;
  Future<void>? microphoneReady;
  StreamSubscription? audioSub;
  DictationSession? dictation;
  StreamSubscription? partialSub;
  StreamSubscription<DatabaseEvent>? historySub;
  StreamSubscription<DatabaseEvent>? statusSub;

  Future<void> disposeDictation() async {
    try {
      await partialSub?.cancel();
    } catch (_) {}
    dictation?.dispose();
    dictation = null;
    partialSub = null;
  }

  Future<void> disposeMicrophone() async {
    try {
      await audioSub?.cancel();
      await recorder?.stop();
    } catch (_) {}
    recorder?.dispose();
    recorder = null;
    audioSub = null;
    microphoneReady = null;
  }

  Future<void> disposeAll() async {
    await historySub?.cancel();
    await statusSub?.cancel();
    historySub = null;
    statusSub = null;
    await disposeDictation();
    await disposeMicrophone();
  }
}

final Map<String, _RemoteSessionRuntime> _runtimes = {};

_RemoteSessionRuntime _runtime(String sessionId) =>
    _runtimes.putIfAbsent(sessionId, () => _RemoteSessionRuntime());

void _mutateSession(
  String sessionId,
  void Function(RemoteSessionStateDraft session) update,
) {
  produceAppState((draft) {
    final session = draft.remote.sessionById[sessionId];
    if (session == null) return;
    update(session);
  });
}

void subscribeToRemoteSession(String sessionId) {
  final uid = FirebaseAuth.instance.currentUser?.uid;
  if (uid == null) return;

  final runtime = _runtime(sessionId);
  runtime.historySub?.cancel();
  runtime.statusSub?.cancel();

  produceAppState((draft) {
    draft.remote.sessionById.putIfAbsent(
      sessionId,
      () => const RemoteSessionState().draft(),
    );
  });

  final historyRef = FirebaseDatabase.instance.ref(
    'session/$uid/$sessionId/history',
  );
  runtime.historySub = historyRef.onValue.listen((event) {
    final raw = event.snapshot.value;
    final entries = <SessionHistoryEntry>[];
    if (raw is Map) {
      raw.forEach((key, value) {
        if (value is String) {
          final entry = SessionHistoryEntry.tryDecode(
            value,
            id: key as String?,
          );
          if (entry != null) entries.add(entry);
        }
      });
      entries.sort((a, b) => a.time.compareTo(b.time));
    }
    _ingestHistory(sessionId, entries);
  });

  final statusRef = FirebaseDatabase.instance.ref(
    'session/$uid/$sessionId/status',
  );
  runtime.statusSub = statusRef.onValue.listen((event) {
    final value = event.snapshot.value;
    final loading = value is String && value == 'loading';
    _mutateSession(sessionId, (s) => s.isLoading = loading);
  });
}

Future<void> _ensureMicrophone(String sessionId) {
  final runtime = _runtime(sessionId);
  return runtime.microphoneReady ??= _startMicrophone(sessionId);
}

Future<void> _startMicrophone(String sessionId) async {
  final runtime = _runtime(sessionId);
  try {
    final recorder = AudioRecorder();
    runtime.recorder = recorder;

    final stream = await recorder.startStream(
      const RecordConfig(
        encoder: AudioEncoder.pcm16bits,
        sampleRate: 16000,
        numChannels: 1,
      ),
    );

    runtime.audioSub = stream.listen((chunk) {
      final dictation = runtime.dictation;
      if (dictation == null) return;
      dictation.sendAudio(chunk);
      final level = computeAudioLevel(chunk);
      _mutateSession(sessionId, (s) => s.audioLevel = level);
    });
  } catch (e) {
    _logger.e('Failed to start microphone: $e');
    runtime.microphoneReady = null;
    await runtime.disposeMicrophone();
  }
}

Future<void> unsubscribeFromRemoteSession(String sessionId) async {
  final runtime = _runtimes.remove(sessionId);
  await runtime?.disposeAll();

  produceAppState((draft) {
    draft.remote.sessionById.remove(sessionId);
  });
}

void _ingestHistory(String sessionId, List<SessionHistoryEntry> entries) {
  produceAppState((draft) {
    final session = draft.remote.sessionById[sessionId];
    if (session == null) return;

    final previousIds = session.historyIds.toSet();
    final nextIds = <String>[];
    for (final entry in entries) {
      final id = entry.id;
      if (id == null) continue;
      draft.sessionHistoryEntryById[id] = entry.draft();
      nextIds.add(id);
    }
    for (final id in previousIds) {
      if (!nextIds.contains(id)) {
        draft.sessionHistoryEntryById.remove(id);
      }
    }
    session.historyIds = nextIds;
  });
}

Future<void> startRemoteRecording(
  String sessionId, {
  required DictationContext context,
}) async {
  final state = getAppState();
  if (state.remote.session(sessionId).isRecording) return;
  if (isMeetingRecording) {
    showSnackbar('Pause your meeting to dictate to your computer.');
    return;
  }

  _mutateSession(sessionId, (s) {
    s.status = DictationPillStatus.recording;
    s.dictationContext = context;
  });

  final runtime = _runtime(sessionId);
  try {
    await _ensureMicrophone(sessionId);

    final dictation = await createDictationSession();
    runtime.dictation = dictation;

    final currentState = getAppState();
    final glossary = currentState.termById.values
        .map((t) => t.sourceValue)
        .toList();
    final language = currentState.activeDictationLanguage;

    await dictation.start(
      sampleRate: 16000,
      glossary: glossary,
      language: language,
    );

    runtime.partialSub = dictation.partialTranscripts.listen((text) {
      _mutateSession(sessionId, (s) => s.partialText = text);
    });
  } catch (e) {
    _logger.e('Failed to start recording: $e');
    cancelRemoteRecording(sessionId);
  }
}

Future<void> stopRemoteRecording(
  String sessionId, {
  required DictationTarget target,
}) async {
  final session = getAppState().remote.session(sessionId);
  if (!session.isRecording) return;

  final runtime = _runtime(sessionId);
  final dictation = runtime.dictation;
  final partialSub = runtime.partialSub;
  runtime.dictation = null;
  runtime.partialSub = null;

  final wasDenying = session.isDenying;

  _mutateSession(sessionId, (s) {
    s.status = DictationPillStatus.idle;
    s.dictationContext = DictationContext.none;
    s.audioLevel = 0;
    s.partialText = '';
    if (!wasDenying) s.isDenying = false;
  });

  unawaited(
    _finalizeInBackground(
      sessionId: sessionId,
      dictation: dictation,
      partialSub: partialSub,
      target: target,
      wasDenying: wasDenying,
    ),
  );
}

Future<void> _finalizeInBackground({
  required String sessionId,
  DictationSession? dictation,
  StreamSubscription? partialSub,
  required DictationTarget target,
  required bool wasDenying,
}) async {
  try {
    await partialSub?.cancel();

    if (dictation == null) return;
    final result = await dictation.finalize();
    final text = result.text.trim();
    if (text.isEmpty) return;

    await _routeDictation(
      sessionId,
      text,
      target: target,
      wasDenying: wasDenying,
    );
  } catch (e) {
    _logger.e('Failed to finalize: $e');
  } finally {
    dictation?.dispose();
    if (wasDenying) {
      _mutateSession(sessionId, (s) => s.isDenying = false);
    }
  }
}

Future<void> _routeDictation(
  String sessionId,
  String text, {
  required DictationTarget target,
  required bool wasDenying,
}) async {
  if (target == DictationTarget.freeForm) {
    await sendPasteText(sessionId, text);
    return;
  }

  final turn = activeTurnFor(sessionId, getAppState());

  if (turn == null) {
    await sendPasteText(sessionId, text);
    return;
  }

  if (wasDenying) {
    final reviewIndex = turn.nextPendingReviewIndex;
    if (reviewIndex != null) {
      final updated = _updateReview(
        turn,
        reviewIndex,
        (r) => r.copyWith(
          status: AssistantReviewStatus.denied,
          response: text,
        ),
      );
      await _persistAndMaybeReply(sessionId, updated);
      return;
    }
  }

  final questionIndex = turn.nextPendingQuestionIndex;
  if (questionIndex != null) {
    final updated = _updateQuestion(
      turn,
      questionIndex,
      (q) => q.copyWith(response: text),
    );
    await _persistAndMaybeReply(sessionId, updated);
    return;
  }

  await sendPasteText(sessionId, text);
}

SessionHistoryEntry _updateReview(
  SessionHistoryEntry entry,
  int index,
  AssistantReview Function(AssistantReview) update,
) {
  final list = [...entry.reviewList];
  list[index] = update(list[index]);
  return entry.produce((d) => d.reviews = list);
}

SessionHistoryEntry _updateQuestion(
  SessionHistoryEntry entry,
  int index,
  AssistantQuestion Function(AssistantQuestion) update,
) {
  final list = [...entry.questionList];
  list[index] = update(list[index]);
  return entry.produce((d) => d.questions = list);
}

Future<void> _persistAndMaybeReply(
  String sessionId,
  SessionHistoryEntry entry,
) async {
  final id = entry.id;
  if (id != null) {
    produceAppState((draft) {
      draft.sessionHistoryEntryById[id] = entry.draft();
    });
  }
  await updateHistoryEntry(sessionId: sessionId, entry: entry);
  if (!entry.hasPendingItems) {
    final reply = _compileReply(entry);
    if (reply.isNotEmpty) {
      await sendPasteText(sessionId, reply);
    }
  }
}

String _compileReply(SessionHistoryEntry entry) {
  final denied = entry.reviewList.where((r) => r.isDenied).toList();
  final questions = entry.questionList;
  final hasDenied = denied.isNotEmpty;
  final hasQuestions = questions.isNotEmpty;

  final buf = StringBuffer();

  if (hasDenied) {
    buf.writeln("Let's change a few things:");
    buf.writeln();
    for (final r in denied) {
      buf.writeln('- ${r.message}');
      buf.writeln('  → ${r.response ?? ''}');
    }
  }

  if (hasQuestions) {
    if (buf.isNotEmpty) buf.writeln();
    buf.writeln('Answers:');
    for (final q in questions) {
      buf.writeln('- ${q.message}');
      buf.writeln('  → ${q.response ?? ''}');
    }
  }

  return buf.toString().trim();
}

void cancelRemoteRecording(String sessionId) {
  final runtime = _runtimes[sessionId];
  _mutateSession(sessionId, (s) {
    s.status = DictationPillStatus.idle;
    s.dictationContext = DictationContext.none;
    s.audioLevel = 0;
    s.partialText = '';
    s.isDenying = false;
  });
  if (runtime != null) {
    unawaited(runtime.disposeDictation());
  }
}

Future<void> approveReview(String sessionId, int reviewIndex) async {
  final turn = activeTurnFor(sessionId, getAppState());
  if (turn == null) return;
  final updated = _updateReview(
    turn,
    reviewIndex,
    (r) => r.copyWith(status: AssistantReviewStatus.approved),
  );
  await _persistAndMaybeReply(sessionId, updated);
}

Future<void> denyReview(String sessionId, int reviewIndex) async {
  _mutateSession(sessionId, (s) => s.isDenying = true);
  await startRemoteRecording(sessionId, context: DictationContext.review);
}
