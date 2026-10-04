import 'package:flutter_test/flutter_test.dart';
import 'package:app/model/keyboard/keyboard_toolbar_model.dart';

void main() {
  group('KeyboardToolbarModel payload validation', () {
    test('visible actions are a subset of all actions', () {
      const model = KeyboardToolbarModel(
        visibleActions: ['startStop', 'language', 'mode'],
        activeMode: 'Auto',
      );
      // toJson should include both fields
      final json = model.toJson();
      expect(json['visibleActions'], isA<List>());
      expect(json['activeMode'], 'Auto');
    });

    test('overflow actions excludes items already in visibleActions', () {
      const model = KeyboardToolbarModel(
        visibleActions: ['startStop', 'language', 'mode'],
        activeMode: 'Manual',
      );
      final overflow = model.overflowActions;
      // startStop, language, mode are visible, so overflow should not contain them
      expect(overflow, isNot(contains('startStop')));
      expect(overflow, isNot(contains('language')));
      expect(overflow, isNot(contains('mode')));
    });

    test('toJson round-trips correctly', () {
      const model = KeyboardToolbarModel(
        visibleActions: ['startStop'],
        activeMode: 'Auto',
      );
      final json = model.toJson();
      final restored = KeyboardToolbarModel.fromJson(json);
      expect(restored.visibleActions, model.visibleActions);
      expect(restored.activeMode, model.activeMode);
    });
  });
}
