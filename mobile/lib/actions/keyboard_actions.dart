import 'package:app/actions/ai_settings_actions.dart';
import 'package:app/actions/idle_timeout_actions.dart';
import 'package:app/actions/app_actions.dart';
import 'package:app/actions/language_actions.dart';
import 'package:app/api/counter_api.dart';
import 'package:app/model/keyboard/keyboard.dart';
import 'package:app/model/tone_model.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/channel_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:app/utils/tone_utils.dart';
import 'package:app/utils/user_utils.dart';
import 'package:flutter/foundation.dart';

final _logger = createNamedLogger('keyboard_actions');
Future<void> Function() _refreshMainData = refreshMainData;

@visibleForTesting
void overrideRefreshMainDataForTest(Future<void> Function() fn) {
  _refreshMainData = fn;
}

@visibleForTesting
void resetRefreshMainDataOverride() {
  _refreshMainData = refreshMainData;
}

Future<void> _incrementAppCounter() async {
  try {
    await IncrementKeyboardCounterApi().call(null);
  } catch (e) {
    _logger.w('Failed to increment app counter', e);
  }
}

Map<String, dynamic> _serializeKeyboardKey(KeyboardKeyModel key) {
  return {
    'id': key.id,
    'role': key.role.name,
    'label': key.label,
    'flex': key.flex,
    if (key.value != null) 'value': key.value,
  };
}

Map<String, dynamic> _serializeKeyboardLayout(KeyboardLayoutModel layout) {
  List<List<Map<String, dynamic>>> serializeRows(
    List<List<KeyboardKeyModel>> rows,
  ) {
    return rows
        .map(
          (row) => row
              .map((key) => _serializeKeyboardKey(key))
              .toList(growable: false),
        )
        .toList(growable: false);
  }

  return {
    'languageCode': layout.languageCode,
    'alphaRows': serializeRows(layout.alphaRows),
    'numericRows': serializeRows(layout.numericRows),
    'symbolRows': serializeRows(layout.symbolRows),
    'shift': _serializeKeyboardKey(layout.shift),
    'bottomRow': {
      'mode': _serializeKeyboardKey(layout.bottomRow.mode),
      'globe': _serializeKeyboardKey(layout.bottomRow.globe),
      'space': _serializeKeyboardKey(layout.bottomRow.space),
      'delete': _serializeKeyboardKey(layout.bottomRow.delete),
      'enter': _serializeKeyboardKey(layout.bottomRow.enter),
    },
  };
}

Map<String, dynamic> _serializeKeyboardLayouts(
  Map<String, KeyboardLayoutModel> layoutsByLanguage,
) {
  return {
    for (final entry in layoutsByLanguage.entries)
      entry.key: _serializeKeyboardLayout(entry.value),
  };
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
  final activeLanguage = getMyActiveDictationLanguage(state);
  final layoutsByLanguage = state.keyboardLayoutsByLanguage.isNotEmpty
      ? state.keyboardLayoutsByLanguage
      : buildKeyboardLayoutsByLanguage(state.dictationLanguages);

  await syncKeyboardLayouts(
    layouts: _serializeKeyboardLayouts(layoutsByLanguage),
    activeLanguage: activeLanguage,
  );
  await syncKeyboardToolbar(
    activeMode: state.keyboardToolbarActiveMode,
    visibleActions: state.keyboardToolbarVisibleActions,
  );
  await syncKeyboardLanguages(
    languages: state.dictationLanguages,
    activeLanguage: activeLanguage,
  );
  await _incrementAppCounter();
}

Future<void> syncDictionaryToKeyboard() async {
  final state = getAppState();
  final termById = <String, SharedTerm>{};
  for (final entry in state.termById.entries) {
    termById[entry.key] = SharedTerm(
      sourceValue: entry.value.sourceValue,
      isReplacement: entry.value.isReplacement,
    );
  }
  await syncKeyboardDictionary(
    termIds: state.dictionary.termIds,
    termById: termById,
  );
  await _incrementAppCounter();
}

/// Called once on keyboard extension init to push all app state to the
/// native keyboard extension. Must run before the keyboard accepts input
/// to ensure layouts, toolbar config, tones, and user data are in sync.
Future<void> syncKeyboardOnInit() async {
  await _refreshMainData();
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
