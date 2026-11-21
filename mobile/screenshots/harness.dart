import 'dart:convert';
import 'dart:io';
import 'dart:ui' as ui;

import 'package:app/store/store.dart';
import 'package:app/theme/build_theme.dart';
import 'package:flutter/material.dart';
import 'package:flutter/rendering.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';
import 'package:google_fonts/google_fonts.dart';

/// Renders real widgets with the app theme and real fonts to PNG files, for
/// reviewing screens without a device. Not part of `flutter test`; run with
/// `flutter test screenshots/<file>_test.dart`.
const outputDir = String.fromEnvironment(
  'SCREENSHOT_DIR',
  defaultValue: '/tmp/voquill-screenshots',
);

/// Serves Flutter's bundled Roboto and Material Icons to google_fonts (as if
/// they were app assets) and to the engine, so screens render with the real
/// typography.
Future<void> loadAppFonts(WidgetTester tester) async {
  GoogleFonts.config.allowRuntimeFetching = false;
  final flutterRoot = Platform.environment['FLUTTER_ROOT']!;
  final fonts = '$flutterRoot/bin/cache/artifacts/material_fonts';
  final files = {
    for (final f in Directory(fonts).listSync().whereType<File>())
      if (f.path.endsWith('.ttf') || f.path.endsWith('.otf'))
        'fonts/${f.uri.pathSegments.last}': f,
  };

  tester.binding.defaultBinaryMessenger.setMockMessageHandler(
    'flutter/assets',
    (message) async {
      final key = utf8.decode(message!.buffer.asUint8List());
      if (key == 'AssetManifest.bin') {
        return const StandardMessageCodec().encodeMessage({
          for (final asset in files.keys)
            asset: [
              {'asset': asset},
            ],
        });
      }
      final file = files[key];
      if (file == null) return null;
      final bytes = file.readAsBytesSync();
      return ByteData.view(bytes.buffer);
    },
  );

  for (final family in ['Roboto']) {
    await _loadRoboto(family, fonts);
  }

  final icons = FontLoader('MaterialIcons')
    ..addFont(
      Future.value(
        ByteData.view(
          File('$fonts/MaterialIcons-Regular.otf').readAsBytesSync().buffer,
        ),
      ),
    );
  await icons.load();
}

Future<void> _loadRoboto(String family, String fonts) async {
  final loader = FontLoader(family);
  for (final name in [
    'Regular',
    'Medium',
    'Bold',
    'Light',
    'Italic',
    'Black',
  ]) {
    loader.addFont(
      Future.value(
        ByteData.view(File('$fonts/Roboto-$name.ttf').readAsBytesSync().buffer),
      ),
    );
  }
  await loader.load();
}

/// Button labels have no font family, so a device draws them in its system
/// font; the test engine would draw boxes. Roboto stands in for it here.
ThemeData _withButtonFont(ThemeData theme) {
  ButtonStyle? patch(ButtonStyle? style) => style?.copyWith(
    textStyle: WidgetStatePropertyAll(
      (style.textStyle?.resolve({}) ?? const TextStyle()).copyWith(
        fontFamily: 'Roboto',
      ),
    ),
  );
  return theme.copyWith(
    filledButtonTheme: FilledButtonThemeData(
      style: patch(theme.filledButtonTheme.style),
    ),
    textButtonTheme: TextButtonThemeData(
      style: patch(theme.textButtonTheme.style),
    ),
    outlinedButtonTheme: OutlinedButtonThemeData(
      style: patch(theme.outlinedButtonTheme.style),
    ),
    elevatedButtonTheme: ElevatedButtonThemeData(
      style: patch(theme.elevatedButtonTheme.style),
    ),
    segmentedButtonTheme: SegmentedButtonThemeData(
      style: patch(theme.segmentedButtonTheme.style),
    ),
  );
}

class PhoneSize {
  final String name;
  final Size size;
  final double textScale;
  const PhoneSize(this.name, this.size, {this.textScale = 1});
}

const iPhone15 = PhoneSize('iphone', Size(393, 852));
const smallPhone = PhoneSize('small', Size(320, 640));
const largeText = PhoneSize('large-text', Size(393, 852), textScale: 1.6);

/// Pumps [child] full-screen in the app theme and writes `<name>.png`.
Future<void> capture(
  WidgetTester tester,
  String name,
  Widget child, {
  Brightness brightness = Brightness.light,
  PhoneSize phone = iPhone15,
  Future<void> Function(WidgetTester tester)? interact,
}) async {
  tester.view.physicalSize = phone.size * 3;
  tester.view.devicePixelRatio = 3;
  final key = GlobalKey();
  await tester.pumpWidget(
    StoreScope(
      child: RepaintBoundary(
        key: key,
        child: MediaQuery(
          data: MediaQueryData(
            size: phone.size,
            devicePixelRatio: 3,
            textScaler: TextScaler.linear(phone.textScale),
            padding: const EdgeInsets.only(top: 47, bottom: 34),
            viewPadding: const EdgeInsets.only(top: 47, bottom: 34),
          ),
          child: MaterialApp(
            debugShowCheckedModeBanner: false,
            theme: _withButtonFont(buildLightTheme()),
            darkTheme: _withButtonFont(buildDarkTheme()),
            themeMode: brightness == Brightness.light
                ? ThemeMode.light
                : ThemeMode.dark,
            home: child,
          ),
        ),
      ),
    ),
  );
  await tester.pump(const Duration(milliseconds: 50));
  await interact?.call(tester);
  await tester.pump(const Duration(milliseconds: 400));
  final suffix = brightness == Brightness.dark ? '-dark' : '';
  final file = File('$outputDir/$name$suffix.png');
  await tester.runAsync(() async {
    final boundary =
        key.currentContext!.findRenderObject()! as RenderRepaintBoundary;
    final image = await boundary.toImage(pixelRatio: 2);
    final bytes = await image.toByteData(format: ui.ImageByteFormat.png);
    await file.parent.create(recursive: true);
    await file.writeAsBytes(bytes!.buffer.asUint8List());
  });
}
