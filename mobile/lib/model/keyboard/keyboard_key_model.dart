import 'package:equatable/equatable.dart';

enum KeyboardKeyRole {
  character,
  shift,
  delete,
  space,
  enter,
  mode,
  language,
  globe,
  overflow,
  startStop,
}

class KeyboardKeyModel with EquatableMixin {
  final String id;
  final KeyboardKeyRole role;
  final String label;
  final String? value;
  final int flex;

  const KeyboardKeyModel._internal({
    required this.id,
    required this.role,
    required this.label,
    this.value,
    required this.flex,
  });

  factory KeyboardKeyModel({
    required String id,
    required KeyboardKeyRole role,
    required String label,
    String? value,
    int flex = 1,
  }) {
    if (role == KeyboardKeyRole.character && value == null) {
      throw ArgumentError.value(
        value,
        'value',
        'Character keys require a value.',
      );
    }

    return KeyboardKeyModel._internal(
      id: id,
      role: role,
      label: label,
      value: value,
      flex: flex,
    );
  }

  factory KeyboardKeyModel.character({
    required String id,
    required String value,
    String? label,
  }) {
    return KeyboardKeyModel._internal(
      id: id,
      role: KeyboardKeyRole.character,
      label: label ?? value,
      value: value,
      flex: 1,
    );
  }

  factory KeyboardKeyModel.action({
    required String id,
    required KeyboardKeyRole role,
    required String label,
    int flex = 1,
  }) {
    if (role == KeyboardKeyRole.character) {
      throw ArgumentError.value(
        role,
        'role',
        'Use KeyboardKeyModel.character for character keys.',
      );
    }

    return KeyboardKeyModel._internal(
      id: id,
      role: role,
      label: label,
      value: null,
      flex: flex,
    );
  }

  bool get isCharacter => role == KeyboardKeyRole.character;

  @override
  List<Object?> get props => [id, role, label, value, flex];
}
