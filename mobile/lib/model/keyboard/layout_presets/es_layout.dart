import 'package:app/model/keyboard/keyboard_layout_model.dart';
import 'package:app/model/keyboard/keyboard_toolbar_model.dart';
import 'package:app/model/keyboard/layout_presets/layout_helpers.dart';
import 'package:app/utils/keyboard_layout_utils.dart';

KeyboardLayoutModel buildSpanishLayout() {
  return KeyboardLayoutModel(
    languageCode: 'es',
    alphaRows: [
      buildCharacterKeyRow('qwertyuiop'),
      buildCharacterKeys(['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l', 'ñ']),
      buildCharacterKeyRow('zxcvbnm'),
    ],
    numericRows: standardNumericRows(),
    symbolRows: standardSymbolRows(),
    shift: standardShift(),
    bottomRow: standardBottomRow(),
    toolbar: KeyboardToolbarModel.standard(),
  );
}
