import 'package:app/model/keyboard/keyboard.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  test('english alpha layout exposes stable semantic keys', () {
    final layout = KeyboardLayoutModel.englishQwerty();

    expect(layout.alphaRows.length, 3);
    expect(layout.shift.role, KeyboardKeyRole.shift);
    expect(layout.bottomRow.space.role, KeyboardKeyRole.space);
    expect(layout.bottomRow.delete.role, KeyboardKeyRole.delete);
  });

  test('keyboard state toggles alpha -> shift -> caps deterministically', () {
    var state = const KeyboardStateModel.alpha();

    state = state.onShiftTap();
    expect(state.caseState, KeyboardCaseState.shift);

    state = state.onShiftDoubleTap();
    expect(state.caseState, KeyboardCaseState.capsLock);
  });

  test('caps lock survives layer changes back to alpha', () {
    var state = const KeyboardStateModel.alpha(
      caseState: KeyboardCaseState.capsLock,
    );

    state = state.showNumeric();
    state = state.showAlpha();

    expect(state.caseState, KeyboardCaseState.capsLock);
  });

  test('character commit clears shift back to lower', () {
    final state = const KeyboardStateModel.alpha(
      caseState: KeyboardCaseState.shift,
    );

    final updatedState = state.onCharacterCommit();

    expect(updatedState.caseState, KeyboardCaseState.lower);
  });

  test('character commit preserves caps lock', () {
    final state = const KeyboardStateModel.alpha(
      caseState: KeyboardCaseState.capsLock,
    );

    final updatedState = state.onCharacterCommit();

    expect(updatedState.caseState, KeyboardCaseState.capsLock);
  });

  test('character commit keeps lower state unchanged', () {
    final state = const KeyboardStateModel.alpha();

    final updatedState = state.onCharacterCommit();

    expect(updatedState.caseState, KeyboardCaseState.lower);
  });

  test('toolbar exposes a distinct persistent language action', () {
    final toolbar = KeyboardToolbarModel.standard();

    expect(toolbar.visibleActions, contains('language'));
    expect(toolbar.visibleActions, containsAllInOrder(['startStop', 'language', 'mode']));
  });

  test('layout copyWith overrides shared contract fields', () {
    final layout = KeyboardLayoutModel.englishQwerty();
    final customBottomRow = KeyboardBottomRowModel(
      mode: KeyboardKeyModel.action(
        id: 'custom-mode',
        role: KeyboardKeyRole.mode,
        label: 'ABC',
      ),
      globe: KeyboardKeyModel.action(
        id: 'custom-globe',
        role: KeyboardKeyRole.globe,
        label: '🌐',
      ),
      space: KeyboardKeyModel.action(
        id: 'custom-space',
        role: KeyboardKeyRole.space,
        label: 'space',
        flex: 5,
      ),
      delete: KeyboardKeyModel.action(
        id: 'custom-delete',
        role: KeyboardKeyRole.delete,
        label: '⌫',
      ),
      enter: KeyboardKeyModel.action(
        id: 'custom-enter',
        role: KeyboardKeyRole.enter,
        label: 'go',
      ),
    );
    final customToolbar = const KeyboardToolbarModel(
      visibleActions: ['startStop', 'language'],
      activeMode: 'Manual',
    );

    final updatedLayout = layout.copyWith(
      languageCode: 'fr',
      bottomRow: customBottomRow,
      toolbar: customToolbar,
    );

    expect(updatedLayout.languageCode, 'fr');
    expect(updatedLayout.bottomRow, customBottomRow);
    expect(updatedLayout.toolbar, customToolbar);
  });

  test('shift double tap is ignored outside alpha layer', () {
    final state = const KeyboardStateModel.numeric();

    final updatedState = state.onShiftDoubleTap();

    expect(updatedState.layerState, KeyboardLayerState.numeric);
    expect(updatedState.caseState, KeyboardCaseState.lower);
  });

  test('shift tap is ignored outside alpha layer', () {
    final state = const KeyboardStateModel.symbols();

    final updatedState = state.onShiftTap();

    expect(updatedState.layerState, KeyboardLayerState.symbols);
    expect(updatedState.caseState, KeyboardCaseState.lower);
  });

  test('layout snapshots nested rows immutably', () {
    final sourceRow = <KeyboardKeyModel>[
      KeyboardKeyModel.character(id: 'character-a', value: 'a'),
    ];
    final sourceRows = <List<KeyboardKeyModel>>[sourceRow];
    final layout = KeyboardLayoutModel(
      languageCode: 'en',
      alphaRows: sourceRows,
      numericRows: const [],
      symbolRows: const [],
      shift: KeyboardKeyModel.action(
        id: 'shift',
        role: KeyboardKeyRole.shift,
        label: 'shift',
      ),
      bottomRow: KeyboardBottomRowModel(
        mode: KeyboardKeyModel.action(
          id: 'mode',
          role: KeyboardKeyRole.mode,
          label: '123',
        ),
        globe: KeyboardKeyModel.action(
          id: 'globe',
          role: KeyboardKeyRole.globe,
          label: '🌐',
        ),
        space: KeyboardKeyModel.action(
          id: 'space',
          role: KeyboardKeyRole.space,
          label: 'space',
        ),
        delete: KeyboardKeyModel.action(
          id: 'delete',
          role: KeyboardKeyRole.delete,
          label: '⌫',
        ),
        enter: KeyboardKeyModel.action(
          id: 'enter',
          role: KeyboardKeyRole.enter,
          label: 'return',
        ),
      ),
      toolbar: KeyboardToolbarModel.standard(),
    );

    sourceRow.add(KeyboardKeyModel.character(id: 'character-b', value: 'b'));
    sourceRows.add(<KeyboardKeyModel>[]);

    expect(layout.alphaRows, hasLength(1));
    expect(layout.alphaRows.first, hasLength(1));
    expect(
      () => layout.alphaRows.add(<KeyboardKeyModel>[]),
      throwsUnsupportedError,
    );
    expect(
      () => layout.alphaRows.first.add(
        KeyboardKeyModel.character(id: 'character-c', value: 'c'),
      ),
      throwsUnsupportedError,
    );
  });

  test('action constructor rejects character role without a value', () {
    expect(
      () => KeyboardKeyModel.action(
        id: 'invalid-character',
        role: KeyboardKeyRole.character,
        label: 'a',
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('base constructor rejects character role without a value', () {
    expect(
      () => KeyboardKeyModel(
        id: 'invalid-base-character',
        role: KeyboardKeyRole.character,
        label: 'a',
      ),
      throwsA(isA<ArgumentError>()),
    );
  });

  test('keyboard layout payload includes separate alpha, numeric, and symbol layers', () {
    final layout = KeyboardLayoutModel.englishQwerty();
    final payload = {
      'languageCode': layout.languageCode,
      'alphaRows': layout.alphaRows
          .map((row) => row.map((k) => {'role': k.role.name}).toList())
          .toList(),
      'numericRows': layout.numericRows
          .map((row) => row.map((k) => {'role': k.role.name}).toList())
          .toList(),
      'symbolRows': layout.symbolRows
          .map((row) => row.map((k) => {'role': k.role.name}).toList())
          .toList(),
    };
    expect(payload['alphaRows'], hasLength(3));
    expect(payload['numericRows'], hasLength(greaterThan(0)));
    expect(payload['symbolRows'], hasLength(greaterThan(0)));
  });
}
