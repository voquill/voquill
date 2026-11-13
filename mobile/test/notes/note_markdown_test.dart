import 'package:app/widgets/notes/note_markdown.dart';
import 'package:flutter/material.dart';
import 'package:flutter/services.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  final launched = <String>[];

  setUp(() {
    launched.clear();
    TestDefaultBinaryMessengerBinding.instance.defaultBinaryMessenger
        .setMockMethodCallHandler(
          const MethodChannel('plugins.flutter.io/url_launcher'),
          (call) async {
            if (call.method == 'launch') {
              launched.add((call.arguments as Map)['url'] as String);
            }
            return true;
          },
        );
  });

  Future<void> pump(WidgetTester tester, String markdown) {
    return tester.pumpWidget(
      MaterialApp(
        home: Scaffold(body: NoteMarkdown(data: markdown)),
      ),
    );
  }

  testWidgets('never loads images or renders raw HTML', (tester) async {
    await pump(
      tester,
      'Summary ![tracker](https://evil.test/pixel.png)\n\n'
      '<img src="https://evil.test/inline.png"> after\n\n'
      '![](file:///etc/hosts)',
    );
    await tester.pump();

    expect(find.byType(Image), findsNothing);
    expect(
      find.textContaining('[tracker]', findRichText: true),
      findsOneWidget,
    );
    expect(find.textContaining('[image]', findRichText: true), findsOneWidget);
    expect(find.textContaining('<img', findRichText: true), findsOneWidget);
    expect(launched, isEmpty);
  });

  testWidgets('links open only when tapped, and only web or mail links', (
    tester,
  ) async {
    await pump(tester, '[Agenda](https://example.com/agenda)');
    await tester.pump();
    expect(launched, isEmpty);

    await tester.tap(find.textContaining('Agenda', findRichText: true));
    await tester.pumpAndSettle();
    expect(launched, isEmpty, reason: 'the address is shown first');
    expect(find.text('https://example.com/agenda'), findsOneWidget);
    await tester.tap(find.text('Open'));
    await tester.pumpAndSettle();
    expect(launched, ['https://example.com/agenda']);

    await pump(tester, '[Run](javascript:alert(1))');
    await tester.pump();
    await tester.tap(find.textContaining('Run', findRichText: true));
    await tester.pumpAndSettle();
    expect(find.text('Open link?'), findsNothing);
    expect(launched, hasLength(1));
  });
}
