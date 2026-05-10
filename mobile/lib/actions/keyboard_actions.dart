import 'package:app/actions/ai_settings_actions.dart';
import 'package:app/actions/idle_timeout_actions.dart';
import 'package:app/actions/app_actions.dart';
import 'package:app/api/counter_api.dart';
import 'package:app/model/tone_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/channel_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:app/utils/tone_utils.dart';
import 'package:app/utils/user_utils.dart';

final _logger = createNamedLogger('keyboard_actions');

Future<void> _incrementAppCounter() async {
  try {
    await IncrementKeyboardCounterApi().call(null);
  } catch (e) {
    _logger.w('Failed to increment app counter', e);
  }
}

Future<void> syncTonesToKeyboard() async {
  final state = getAppState();
  final activeToneIds = getActiveSortedToneIds(state);
  final toneById = <String, SharedTone>{};
  for (final entry in state.toneById.entries) {
    toneById[entry.key] = SharedTone(
      name: entry.value.name,
      promptTemplate: entry.value.promptTemplate,
    );
  }

  final sharedToneId = await getSelectedToneId();
  final selectedToneId =
      (sharedToneId != null && activeToneIds.contains(sharedToneId))
      ? sharedToneId
      : getManuallySelectedToneId(state);

  await syncKeyboardTones(
    selectedToneId: selectedToneId,
    activeToneIds: activeToneIds,
    toneById: toneById,
  );
  await _incrementAppCounter();
}

Future<void> syncUserToKeyboard() async {
  final state = getAppState();
  final user = state.user;
  if (user != null) {
    await syncKeyboardUser(userName: user.name);
    await _incrementAppCounter();
  }
}

Future<void> syncLanguagesToKeyboard() async {
  final state = getAppState();
  await syncKeyboardDictationLanguages(
    languages: state.dictationLanguages,
    activeLanguage: getMyActiveDictationLanguage(state),
  );
  await _incrementAppCounter();
}

Future<void> syncDictionaryToKeyboard() async {
  final state = getAppState();
  final termById = <String, SharedTerm>{};
  for (final entry in state.termById.entries) {
    termById[entry.key] = SharedTerm(
      sourceValue: entry.value.sourceValue,
      destinationValue: entry.value.destinationValue,
      isReplacement: entry.value.isReplacement,
    );
  }
  await syncKeyboardDictionary(
    termIds: state.dictionary.termIds,
    termById: termById,
  );
  await _incrementAppCounter();
}

Future<void> syncKeyboardOnInit() async {
  await refreshMainData();
  await syncLanguagesToKeyboard();
  await syncTonesToKeyboard();
  await syncUserToKeyboard();
  await syncDictionaryToKeyboard();
  await syncKeyboardAiSettings();
  await syncIdleTimeoutOnInit();
}

Future<void> syncIdleTimeoutOnInit() async {
  final keepRunning = await getIdleTimeoutKeepRunning();
  final seconds = await getIdleTimeoutSeconds();
  await syncIdleTimeoutToNative(keepRunning ? 0 : seconds);
}
