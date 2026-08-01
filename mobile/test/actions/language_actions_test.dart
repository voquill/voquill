import 'package:app/actions/language_actions.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('buildKeyboardLayoutsByLanguage returns layouts for en, es, hi', () {
    final layouts = buildKeyboardLayoutsByLanguage(['en', 'es', 'hi']);

    expect(layouts.keys, containsAll(['en', 'es', 'hi']));
    expect(layouts['en']!.languageCode, 'en');
    expect(layouts['es']!.languageCode, 'es');
    expect(layouts['hi']!.languageCode, 'hi');
  });

  test('Spanish layout has ñ in alpha rows', () {
    final layouts = buildKeyboardLayoutsByLanguage(['es']);
    final esLayout = layouts['es']!;
    final allChars = esLayout.alphaRows
        .expand((row) => row)
        .map((k) => k.value ?? k.label)
        .toList();
    expect(allChars, contains('ñ'));
  });

  test('unknown language falls back to English layout with correct languageCode',
      () {
    final layouts = buildKeyboardLayoutsByLanguage(['fr']);
    expect(layouts['fr']!.languageCode, 'fr');
    // alpha rows should be QWERTY
    expect(layouts['fr']!.alphaRows.first.first.value, 'q');
  });
}
