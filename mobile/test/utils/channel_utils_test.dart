import 'package:app/utils/channel_utils.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

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

  List<String> get methods => _calls.map((call) => call.method).toList();

  Object? argumentsFor(String method) {
    return _calls.lastWhere((call) => call.method == method).arguments;
  }
}

final fakeSharedChannel = _FakeSharedChannel();

void main() {
  TestWidgetsFlutterBinding.ensureInitialized();

  setUp(() {
    overrideCanSyncForTest(true);
    fakeSharedChannel.install();
  });

  tearDown(() {
    overrideCanSyncForTest(null);
    fakeSharedChannel.reset();
  });

  test('syncKeyboardLayouts sends layouts and active language', () async {
    final layouts = <String, dynamic>{
      'en': <String, dynamic>{'languageCode': 'en'},
    };

    await syncKeyboardLayouts(layouts: layouts, activeLanguage: 'en');

    expect(fakeSharedChannel.methods, contains('setKeyboardLayouts'));
    expect(
      fakeSharedChannel.argumentsFor('setKeyboardLayouts'),
      <String, dynamic>{'layouts': layouts, 'activeLanguage': 'en'},
    );
  });

  test('syncKeyboardToolbar sends active mode and visible actions', () async {
    await syncKeyboardToolbar(
      activeMode: 'dictation',
      visibleActions: <String>['startStop', 'language', 'mode'],
    );

    expect(fakeSharedChannel.methods, contains('setKeyboardToolbar'));
    expect(
      fakeSharedChannel.argumentsFor('setKeyboardToolbar'),
      <String, dynamic>{
        'activeMode': 'dictation',
        'visibleActions': <String>['startStop', 'language', 'mode'],
      },
    );
  });

  test('keyboard toolbar payload includes visible actions and active mode', () async {
    final calls = <String, dynamic>{};
    fakeSharedChannel.onInvoke = (method, args) {
      if (method == 'setKeyboardToolbar') {
        (args as Map).forEach((k, v) => calls[k as String] = v);
      }
      return null;
    };
    await syncKeyboardToolbar(
      activeMode: 'Auto',
      visibleActions: ['startStop', 'language', 'mode'],
    );
    expect(calls['activeMode'], 'Auto');
    expect(calls['visibleActions'], containsAll(['startStop', 'language', 'mode']));
  });

  test('syncKeyboardLanguages sends languages and active language', () async {
    await syncKeyboardLanguages(
      languages: <String>['en', 'fr'],
      activeLanguage: 'fr',
    );

    expect(fakeSharedChannel.methods, contains('setKeyboardLanguages'));
    expect(
      fakeSharedChannel.argumentsFor('setKeyboardLanguages'),
      <String, dynamic>{
        'languages': <String>['en', 'fr'],
        'activeLanguage': 'fr',
        'languageMetadata': <String, dynamic>{
          'en': <String, dynamic>{'displayName': 'English'},
          'fr': <String, dynamic>{'displayName': 'Français'},
        },
      },
    );
  });
}
