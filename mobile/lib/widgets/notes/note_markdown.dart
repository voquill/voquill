import 'package:app/theme/app_colors.dart';
import 'package:app/utils/url_utils.dart';
import 'package:flutter/material.dart';
import 'package:flutter_markdown_plus/flutter_markdown_plus.dart';
import 'package:markdown/markdown.dart' as md;

/// GitHub-flavored Markdown without raw HTML: AI notes and Ask answers are
/// derived from transcripts and pasted text that third parties may have
/// written, so raw tags stay visible as text.
final _noteExtensionSet = md.ExtensionSet(
  md.ExtensionSet.gitHubFlavored.blockSyntaxes,
  md.ExtensionSet.gitHubFlavored.inlineSyntaxes
      .where((syntax) => syntax is! md.InlineHtmlSyntax)
      .toList(),
);

const _openableSchemes = {'http', 'https', 'mailto'};

/// Renders untrusted Markdown: images never load (their alt text is shown
/// instead) and links open only when the user taps and confirms them.
class NoteMarkdown extends StatelessWidget {
  const NoteMarkdown({
    super.key,
    required this.data,
    this.isScrollable = false,
    this.padding = EdgeInsets.zero,
  });

  final String data;
  final bool isScrollable;
  final EdgeInsets padding;

  static Widget _imageAsText(Uri uri, String? title, String? alt) {
    final text = alt?.trim().isNotEmpty == true ? alt!.trim() : 'image';
    return Text('[$text]');
  }

  /// Links open only after the user saw the address and confirmed it
  /// (docs/notes.md, Rendering).
  static Future<void> _onTapLink(BuildContext context, String? href) async {
    final uri = href == null ? null : Uri.tryParse(href);
    if (uri == null || !_openableSchemes.contains(uri.scheme)) return;
    final confirmed = await showDialog<bool>(
      context: context,
      builder: (context) => AlertDialog(
        title: const Text('Open link?'),
        content: SelectableText(uri.toString()),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            child: const Text('Open'),
          ),
        ],
      ),
    );
    if (confirmed ?? false) await openUrl(uri.toString());
  }

  /// The app's type scale: bold headings, body at the reading size, quiet
  /// table rules and code blocks on the card colour.
  static MarkdownStyleSheet _styleSheet(BuildContext context) {
    final theme = Theme.of(context);
    final colors = context.colors;
    final text = theme.textTheme;
    return MarkdownStyleSheet.fromTheme(theme).copyWith(
      p: text.bodyMedium,
      h1: text.headlineSmall,
      h2: text.titleLarge?.copyWith(fontWeight: FontWeight.w700),
      h3: text.titleMedium?.copyWith(fontWeight: FontWeight.w600),
      h1Padding: const EdgeInsets.only(top: 16),
      h2Padding: const EdgeInsets.only(top: 16),
      h3Padding: const EdgeInsets.only(top: 12),
      listBullet: text.bodyMedium,
      blockSpacing: 12,
      code: text.bodySmall?.copyWith(
        fontFamily: 'monospace',
        backgroundColor: colors.level1,
      ),
      codeblockDecoration: BoxDecoration(
        color: colors.level1,
        borderRadius: BorderRadius.circular(8),
      ),
      blockquoteDecoration: BoxDecoration(
        border: Border(left: BorderSide(color: colors.level2, width: 3)),
      ),
      tableHead: text.bodySmall?.copyWith(fontWeight: FontWeight.w600),
      tableBody: text.bodySmall,
      tableBorder: TableBorder.all(color: colors.level2),
      tableCellsPadding: const EdgeInsets.symmetric(horizontal: 8, vertical: 6),
      tableColumnWidth: const IntrinsicColumnWidth(),
    );
  }

  @override
  Widget build(BuildContext context) {
    final styleSheet = _styleSheet(context);
    return isScrollable
        ? Markdown(
            data: data,
            selectable: true,
            padding: padding,
            styleSheet: styleSheet,
            extensionSet: _noteExtensionSet,
            imageBuilder: _imageAsText,
            onTapLink: (_, href, _) => _onTapLink(context, href),
          )
        : Padding(
            padding: padding,
            child: MarkdownBody(
              data: data,
              selectable: true,
              styleSheet: styleSheet,
              extensionSet: _noteExtensionSet,
              imageBuilder: _imageAsText,
              onTapLink: (_, href, _) => _onTapLink(context, href),
            ),
          );
  }
}
