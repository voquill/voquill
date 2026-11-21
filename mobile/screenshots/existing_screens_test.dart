import 'package:app/model/term_model.dart';
import 'package:app/state/app_state.dart';
import 'package:app/state/dictionary_state.dart';
import 'package:app/model/common_model.dart';
import 'package:app/store/store.dart';
import 'package:app/widgets/dictionary/dictionary_page.dart';
import 'package:app/widgets/home/home_page.dart';
import 'package:app/widgets/settings/settings_page.dart';
import 'package:flutter/material.dart';
import 'package:flutter_test/flutter_test.dart';

import 'harness.dart';

void main() {
  testWidgets('existing screens', (tester) async {
    await loadAppFonts(tester);
    setAppState(
      AppState(
        termById: {
          for (var i = 0; i < 6; i++)
            't$i': Term(
              id: 't$i',
              createdAt: '2026-01-01T00:00:00Z',
              sourceValue: 'Term $i',
              destinationValue: i.isEven ? 'Replacement $i' : '',
              isReplacement: i.isEven,
            ),
        },
        dictionary: DictionaryState(
          termIds: [for (var i = 0; i < 6; i++) 't$i'],
          status: ActionStatus.success,
        ),
      ),
    );
    for (final brightness in Brightness.values) {
      await capture(
        tester,
        'existing-dictionary',
        const DictionaryPage(),
        brightness: brightness,
      );
      await capture(
        tester,
        'existing-home',
        const Scaffold(body: HomePage()),
        brightness: brightness,
      );
      await capture(
        tester,
        'existing-settings',
        const SettingsPage(),
        brightness: brightness,
      );
    }
  });
}
