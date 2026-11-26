import 'package:app/model/keyboard/keyboard_key_model.dart';
import 'package:app/model/keyboard/keyboard_layout_model.dart';
import 'package:app/utils/keyboard_layout_utils.dart';

List<List<KeyboardKeyModel>> standardNumericRows() => [
      buildCharacterKeys(['1', '2', '3', '4', '5', '6', '7', '8', '9', '0']),
      buildCharacterKeys(['-', '/', ':', ';', '(', ')', '\$', '&', '@', '"']),
      buildCharacterKeys(['.', ',', '?', '!', "'"]),
    ];

List<List<KeyboardKeyModel>> standardSymbolRows() => [
      buildCharacterKeys(['[', ']', '{', '}', '#', '%', '^', '*', '+', '=']),
      buildCharacterKeys(['_', '\\', '|', '~', '<', '>', '€', '£', '¥', '•']),
      buildCharacterKeys(['.', ',', '?', '!', "'"]),
    ];

KeyboardBottomRowModel standardBottomRow() => KeyboardBottomRowModel(
      mode: KeyboardKeyModel.action(
        id: 'bottom-mode',
        role: KeyboardKeyRole.mode,
        label: '123',
      ),
      globe: KeyboardKeyModel.action(
        id: 'bottom-globe',
        role: KeyboardKeyRole.globe,
        label: '🌐',
      ),
      space: KeyboardKeyModel.action(
        id: 'bottom-space',
        role: KeyboardKeyRole.space,
        label: 'space',
        flex: 4,
      ),
      delete: KeyboardKeyModel.action(
        id: 'bottom-delete',
        role: KeyboardKeyRole.delete,
        label: '⌫',
      ),
      enter: KeyboardKeyModel.action(
        id: 'bottom-enter',
        role: KeyboardKeyRole.enter,
        label: 'return',
      ),
    );

KeyboardKeyModel standardShift() => KeyboardKeyModel.action(
      id: 'alpha-shift',
      role: KeyboardKeyRole.shift,
      label: 'shift',
    );
