import 'package:app/actions/keyboard_actions.dart';
import 'package:app/state/app_state.dart';
import 'package:app/store/store.dart';
import 'package:app/utils/channel_utils.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:shared_preferences/shared_preferences.dart';

class _FakeSharedChannel {
  final MethodChannel _channel = const MethodChannel(
    'com.voquill.mobile/shared',
  );
  final List<MethodCall> _calls = <MethodCall>[];

  dynamic Function(String method, dynamic args)? onInvoke;

  void install() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, (call) async {
          _calls.add(call);
          return onInvoke?.call(call.method, call.arguments);
        });
  }

  void reset() {
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(_channel, null);
    _calls.clear();
    onInvoke = null;
  }
}

final fakeSharedChannel = _FakeSharedChannel();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    SharedPreferences.setMockInitialValues(<String, Object>{});
    overrideCanSyncForTest(true);
    overrideRefreshMainDataForTest(() async {});
    setAppState(
      const AppState(
        dictationLanguages: <String>['en', 'fr'],
        activeDictationLanguage: 'fr',
      ),
    );
    fakeSharedChannel.install();
  });

  tearDown(() {
    overrideCanSyncForTest(null);
    resetRefreshMainDataOverride();
    fakeSharedChannel.reset();
    setAppState(const AppState());
  });

  test(
    'syncKeyboardOnInit pushes layout spec, toolbar config, and active language',
    () async {
      final calls = <String>[];
      final payloads = <String, Object?>{};
      fakeSharedChannel.onInvoke = (method, args) {
        calls.add(method);
        payloads[method] = args;
        return null;
      };

      await syncKeyboardOnInit();

      expect(calls, contains('setKeyboardLayouts'));
      expect(calls, contains('setKeyboardToolbar'));
      expect(calls, contains('setKeyboardLanguages'));
      expect(payloads['setKeyboardLayouts'], isA<Map>());
      expect((payloads['setKeyboardLayouts'] as Map)['activeLanguage'], 'fr');
      expect(
        ((payloads['setKeyboardLayouts'] as Map)['layouts'] as Map).keys,
        containsAll(<String>['en', 'fr']),
      );
      expect(
        (((payloads['setKeyboardLayouts'] as Map)['layouts'] as Map)['fr']
            as Map)['languageCode'],
        'fr',
      );
      expect(
        (payloads['setKeyboardToolbar'] as Map)['activeMode'],
        'Auto',
      );
      expect((payloads['setKeyboardLanguages'] as Map)['activeLanguage'], 'fr');
    },
  );

  test('keyboard toolbar has startStop, language, mode as visible actions', () {
    final state = getAppState();
    expect(
      state.keyboardToolbarVisibleActions,
      containsAll(['startStop', 'language', 'mode']),
    );
  });
}
