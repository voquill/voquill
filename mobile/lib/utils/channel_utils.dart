import 'dart:io' show Platform;

import 'package:app/api/api_token_api.dart';
import 'package:app/api/counter_api.dart';
import 'package:app/flavor.dart';
import 'package:app/model/tone_model.dart';
import 'package:app/utils/env_utils.dart';
import 'package:app/utils/language_utils.dart';
import 'package:app/utils/log_utils.dart';
import 'package:firebase_core/firebase_core.dart';
import 'package:flutter/foundation.dart';
import 'package:flutter/services.dart';

final _logger = createNamedLogger('channel_utils');

const _sharedChannel = MethodChannel('com.voquill.mobile/shared');
bool? _canSyncOverrideForTest;

bool get _canSync {
  return _canSyncOverrideForTest ?? (Platform.isIOS || Platform.isAndroid);
}

@visibleForTesting
void overrideCanSyncForTest(bool? value) {
  _canSyncOverrideForTest = value;
}

Future<void> syncKeyboardAuth() async {
  if (!_canSync) {
    return;
  }

  try {
    final output = await CreateApiTokenApi().call(null);
    final projectId = Firebase.app().options.projectId;
    final apiKey = Firebase.app().options.apiKey;

    final String functionUrl;
    final String authUrl;
    if (Flavor.current.isEmulators) {
      final host = Flavor.current.emulatorHost;
      functionUrl = 'http://$host:5001/$projectId/us-central1/handler';
      authUrl = 'http://$host:9099/identitytoolkit.googleapis.com';
    } else {
      functionUrl = 'https://us-central1-$projectId.cloudfunctions.net/handler';
      authUrl = 'https://identitytoolkit.googleapis.com';
    }

    await _sharedChannel.invokeMethod('setKeyboardAuth', {
      'apiRefreshToken': output.apiRefreshToken,
      'apiKey': apiKey,
      'functionUrl': functionUrl,
      'authUrl': authUrl,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard auth', e);
  }
}

void clearKeyboardAuth() {
  if (!_canSync) {
    return;
  }

  _sharedChannel.invokeMethod('clearKeyboardAuth').catchError((e) {
    _logger.w('Failed to clear keyboard auth', e);
  });
}

Future<void> syncKeyboardTones({
  required String selectedToneId,
  required List<String> activeToneIds,
  required Map<String, SharedTone> toneById,
}) async {
  if (!_canSync) {
    return;
  }

  try {
    final toneMap = <String, Map<String, String>>{};
    for (final entry in toneById.entries) {
      toneMap[entry.key] = entry.value.toMap();
    }

    await _sharedChannel.invokeMethod('setKeyboardTones', {
      'selectedToneId': selectedToneId,
      'activeToneIds': activeToneIds,
      'toneById': toneMap,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard tones', e);
  }
}

Future<String?> getSelectedToneId() async {
  if (!_canSync) return null;
  try {
    return await _sharedChannel.invokeMethod<String?>('getSelectedToneId');
  } catch (e) {
    _logger.w('Failed to get selected tone id', e);
    return null;
  }
}

Future<void> setSelectedToneId(String toneId) async {
  if (!_canSync) return;
  try {
    await _sharedChannel.invokeMethod('setSelectedToneId', {'toneId': toneId});
  } catch (e) {
    _logger.w('Failed to set selected tone id', e);
  }
}

Future<void> syncKeyboardUser({required String userName}) async {
  if (!_canSync) {
    return;
  }

  try {
    await _sharedChannel.invokeMethod('setKeyboardUser', {
      'userName': userName,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard user', e);
  }
}

Future<void> syncKeyboardDictionary({
  required List<String> termIds,
  required Map<String, SharedTerm> termById,
}) async {
  if (!_canSync) {
    return;
  }

  try {
    final termMap = <String, Map<String, dynamic>>{};
    for (final entry in termById.entries) {
      termMap[entry.key] = entry.value.toMap();
    }

    await _sharedChannel.invokeMethod('setKeyboardDictionary', {
      'termIds': termIds,
      'termById': termMap,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard dictionary', e);
  }
}

Future<bool> isKeyboardEnabled() async {
  if (!_canSync) return false;
  try {
    final result = await _sharedChannel.invokeMethod<bool>('isKeyboardEnabled');
    return result ?? false;
  } catch (e) {
    _logger.w('Failed to check keyboard enabled', e);
    return false;
  }
}

Future<void> openKeyboardSettings() async {
  if (!_canSync) return;
  try {
    await _sharedChannel.invokeMethod('openKeyboardSettings');
  } catch (e) {
    _logger.w('Failed to open keyboard settings', e);
  }
}

Future<void> syncMixpanelUser({required String uid}) async {
  if (!_canSync) return;

  _sharedChannel.invokeMethod('setMixpanelUser', {'uid': uid}).catchError((e) {
    _logger.w('Failed to sync Mixpanel user', e);
  });

  await IncrementKeyboardCounterApi().call(null);
}

void syncMixpanelToken() {
  if (!_canSync) {
    return;
  }

  final token = mixpanelToken;
  if (token.isEmpty) {
    return;
  }

  _sharedChannel.invokeMethod('setMixpanelToken', {'token': token}).catchError((
    e,
  ) {
    _logger.w('Failed to sync Mixpanel token', e);
  });
}

Future<void> syncKeyboardAiConfig({
  required String transcriptionMode,
  required String postProcessingMode,
  String? transcriptionProvider,
  String? transcriptionApiKey,
  String? transcriptionBaseUrl,
  String? transcriptionModel,
  String? transcriptionAzureRegion,
  String? postProcessingProvider,
  String? postProcessingApiKey,
  String? postProcessingBaseUrl,
  String? postProcessingModel,
}) async {
  if (!_canSync) return;

  try {
    await _sharedChannel.invokeMethod('setKeyboardAiConfig', {
      'transcriptionMode': transcriptionMode,
      'postProcessingMode': postProcessingMode,
      'transcriptionProvider': ?transcriptionProvider,
      'transcriptionApiKey': ?transcriptionApiKey,
      'transcriptionBaseUrl': ?transcriptionBaseUrl,
      'transcriptionModel': ?transcriptionModel,
      'transcriptionAzureRegion': ?transcriptionAzureRegion,
      'postProcessingProvider': ?postProcessingProvider,
      'postProcessingApiKey': ?postProcessingApiKey,
      'postProcessingBaseUrl': ?postProcessingBaseUrl,
      'postProcessingModel': ?postProcessingModel,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard AI config', e);
  }
}

Future<void> syncKeyboardLayouts({
  required Map<String, dynamic> layouts,
  required String activeLanguage,
}) async {
  if (!_canSync) {
    return;
  }

  try {
    await _sharedChannel.invokeMethod('setKeyboardLayouts', {
      'layouts': layouts,
      'activeLanguage': activeLanguage,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard layouts', e);
  }
}

Future<void> syncKeyboardToolbar({
  required String activeMode,
  required List<String> visibleActions,
}) async {
  if (!_canSync) {
    return;
  }

  try {
    await _sharedChannel.invokeMethod('setKeyboardToolbar', {
      'activeMode': activeMode,
      'visibleActions': visibleActions,
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard toolbar', e);
  }
}

Future<void> syncKeyboardLanguages({
  required List<String> languages,
  required String activeLanguage,
}) async {
  if (!_canSync) {
    return;
  }

  try {
    await _sharedChannel.invokeMethod('setKeyboardLanguages', {
      'languages': languages,
      'activeLanguage': activeLanguage,
      'languageMetadata': {
        for (final language in languages)
          language: {'displayName': getDisplayNameForLanguage(language)},
      },
    });
  } catch (e) {
    _logger.w('Failed to sync keyboard languages', e);
  }
}

Future<void> syncIdleTimeout({required int timeoutSeconds}) async {
  if (!_canSync) {
    return;
  }

  try {
    await _sharedChannel.invokeMethod('setIdleTimeout', {
      'timeoutSeconds': timeoutSeconds,
    });
  } catch (e) {
    _logger.w('Failed to sync idle timeout', e);
  }
}
