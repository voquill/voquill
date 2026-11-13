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
/// instead) and links open only when the user taps them.
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

  static void _onTapLink(String text, String? href, String title) {
    final uri = href == null ? null : Uri.tryParse(href);
    if (uri != null && _openableSchemes.contains(uri.scheme)) {
      openUrl(uri.toString());
    }
  }

  @override
  Widget build(BuildContext context) {
    return isScrollable
        ? Markdown(
            data: data,
            selectable: true,
            padding: padding,
            extensionSet: _noteExtensionSet,
            imageBuilder: _imageAsText,
            onTapLink: _onTapLink,
          )
        : Padding(
            padding: padding,
            child: MarkdownBody(
              data: data,
              selectable: true,
              extensionSet: _noteExtensionSet,
              imageBuilder: _imageAsText,
              onTapLink: _onTapLink,
            ),
          );
  }
}
