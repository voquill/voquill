import 'package:equatable/equatable.dart';

enum KeyboardLayerState { alpha, numeric, symbols }

enum KeyboardCaseState { lower, shift, capsLock }

class KeyboardStateModel with EquatableMixin {
  final KeyboardLayerState layerState;
  final KeyboardCaseState caseState;

  const KeyboardStateModel({required this.layerState, required this.caseState});

  const KeyboardStateModel.alpha({
    KeyboardCaseState caseState = KeyboardCaseState.lower,
  }) : this(layerState: KeyboardLayerState.alpha, caseState: caseState);

  const KeyboardStateModel.numeric()
    : this(
        layerState: KeyboardLayerState.numeric,
        caseState: KeyboardCaseState.lower,
      );

  const KeyboardStateModel.symbols()
    : this(
        layerState: KeyboardLayerState.symbols,
        caseState: KeyboardCaseState.lower,
      );

  bool get isAlpha => layerState == KeyboardLayerState.alpha;
  bool get isUppercase => caseState != KeyboardCaseState.lower;

  KeyboardStateModel onShiftTap() {
    if (!isAlpha) {
      return this;
    }
    return switch (caseState) {
      KeyboardCaseState.lower => copyWith(caseState: KeyboardCaseState.shift),
      KeyboardCaseState.shift => copyWith(caseState: KeyboardCaseState.lower),
      KeyboardCaseState.capsLock => copyWith(
        caseState: KeyboardCaseState.lower,
      ),
    };
  }

  KeyboardStateModel onShiftDoubleTap() {
    if (!isAlpha) {
      return this;
    }
    return copyWith(
      layerState: KeyboardLayerState.alpha,
      caseState: KeyboardCaseState.capsLock,
    );
  }

  KeyboardStateModel onCharacterCommit() {
    if (caseState != KeyboardCaseState.shift) {
      return this;
    }
    return copyWith(caseState: KeyboardCaseState.lower);
  }

  KeyboardStateModel showAlpha() {
    return copyWith(layerState: KeyboardLayerState.alpha);
  }

  KeyboardStateModel showNumeric() {
    return copyWith(layerState: KeyboardLayerState.numeric);
  }

  KeyboardStateModel showSymbols() {
    return copyWith(layerState: KeyboardLayerState.symbols);
  }

  KeyboardStateModel copyWith({
    KeyboardLayerState? layerState,
    KeyboardCaseState? caseState,
  }) {
    return KeyboardStateModel(
      layerState: layerState ?? this.layerState,
      caseState: caseState ?? this.caseState,
    );
  }

  @override
  List<Object?> get props => [layerState, caseState];
}
