import 'package:app/model/keyboard/keyboard_key_model.dart';
import 'package:app/model/keyboard/keyboard_toolbar_model.dart';
import 'package:app/model/keyboard/layout_presets/en_layout.dart';
import 'package:app/utils/keyboard_layout_utils.dart';
import 'package:equatable/equatable.dart';

class KeyboardBottomRowModel with EquatableMixin {
  final KeyboardKeyModel mode;
  final KeyboardKeyModel globe;
  final KeyboardKeyModel space;
  final KeyboardKeyModel delete;
  final KeyboardKeyModel enter;

  const KeyboardBottomRowModel({
    required this.mode,
    required this.globe,
    required this.space,
    required this.delete,
    required this.enter,
  });

  List<KeyboardKeyModel> get keys => [mode, globe, space, delete, enter];

  @override
  List<Object?> get props => [mode, globe, space, delete, enter];
}

class KeyboardLayoutModel with EquatableMixin {
  final String languageCode;
  final List<List<KeyboardKeyModel>> alphaRows;
  final List<List<KeyboardKeyModel>> numericRows;
  final List<List<KeyboardKeyModel>> symbolRows;
  final KeyboardKeyModel shift;
  final KeyboardBottomRowModel bottomRow;
  final KeyboardToolbarModel toolbar;

  KeyboardLayoutModel({
    required this.languageCode,
    required List<List<KeyboardKeyModel>> alphaRows,
    required List<List<KeyboardKeyModel>> numericRows,
    required List<List<KeyboardKeyModel>> symbolRows,
    required this.shift,
    required this.bottomRow,
    required this.toolbar,
  }) : alphaRows = _freezeRows(alphaRows),
       numericRows = _freezeRows(numericRows),
       symbolRows = _freezeRows(symbolRows);

  static List<List<KeyboardKeyModel>> _freezeRows(
    List<List<KeyboardKeyModel>> rows,
  ) {
    return List<List<KeyboardKeyModel>>.unmodifiable(
      rows.map(List<KeyboardKeyModel>.unmodifiable),
    );
  }

  /// Delegates to [buildEnglishLayout] to avoid duplicating the English key
  /// definitions that now live in the layout_presets package.
  factory KeyboardLayoutModel.englishQwerty() => buildEnglishLayout();

  KeyboardLayoutModel copyWith({
    String? languageCode,
    List<List<KeyboardKeyModel>>? alphaRows,
    List<List<KeyboardKeyModel>>? numericRows,
    List<List<KeyboardKeyModel>>? symbolRows,
    KeyboardKeyModel? shift,
    KeyboardBottomRowModel? bottomRow,
    KeyboardToolbarModel? toolbar,
  }) {
    return KeyboardLayoutModel(
      languageCode: languageCode ?? this.languageCode,
      alphaRows: alphaRows ?? this.alphaRows,
      numericRows: numericRows ?? this.numericRows,
      symbolRows: symbolRows ?? this.symbolRows,
      shift: shift ?? this.shift,
      bottomRow: bottomRow ?? this.bottomRow,
      toolbar: toolbar ?? this.toolbar,
    );
  }

  @override
  List<Object?> get props => [
    languageCode,
    alphaRows,
    numericRows,
    symbolRows,
    shift,
    bottomRow,
    toolbar,
  ];
}
