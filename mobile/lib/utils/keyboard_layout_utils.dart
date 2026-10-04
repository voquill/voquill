import 'package:app/model/keyboard/keyboard_key_model.dart';
import 'package:characters/characters.dart';

String semanticCharacterKeyId(String value) {
  return 'character-${value.toLowerCase()}';
}

KeyboardKeyModel buildCharacterKey(String value) {
  return KeyboardKeyModel.character(
    id: semanticCharacterKeyId(value),
    value: value,
  );
}

List<KeyboardKeyModel> buildCharacterKeyRow(String values) {
  return values.characters.map(buildCharacterKey).toList(growable: false);
}

List<KeyboardKeyModel> buildCharacterKeys(Iterable<String> values) {
  return values.map(buildCharacterKey).toList(growable: false);
}
