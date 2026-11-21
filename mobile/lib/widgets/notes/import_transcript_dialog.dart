import 'package:app/actions/notes_actions.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_dialog.dart';
import 'package:flutter/material.dart';

const _maxTranscriptChars = 400000;

/// Paste a transcript; the note is generated in the background, so the dialog
/// closes right away and another import can start immediately.
class ImportTranscriptDialog extends StatefulWidget {
  const ImportTranscriptDialog({super.key});

  static Future<void> show(BuildContext context) => showDialog(
    context: context,
    builder: (_) => const ImportTranscriptDialog(),
  );

  @override
  State<ImportTranscriptDialog> createState() => _ImportTranscriptDialogState();
}

class _ImportTranscriptDialogState extends State<ImportTranscriptDialog> {
  final _title = TextEditingController();
  final _transcript = TextEditingController();

  @override
  void dispose() {
    _title.dispose();
    _transcript.dispose();
    super.dispose();
  }

  bool get _isValid => _transcript.text.trim().isNotEmpty;

  void _submit() {
    importTranscript(transcript: _transcript.text, title: _title.text);
    Navigator.of(context).pop();
  }

  @override
  Widget build(BuildContext context) {
    return AppDialog(
      title: const Text('Import transcript'),
      content: Padding(
        padding: Theming.padding.onlyHorizontal(),
        child: Column(
          mainAxisSize: MainAxisSize.min,
          spacing: Theming.paddingValue,
          children: [
            TextField(
              controller: _title,
              maxLength: 200,
              textCapitalization: TextCapitalization.sentences,
              decoration: const InputDecoration(
                labelText: 'Title (optional)',
                border: OutlineInputBorder(),
                counterText: '',
              ),
            ),
            TextField(
              controller: _transcript,
              minLines: 6,
              maxLines: 12,
              maxLength: _maxTranscriptChars,
              decoration: const InputDecoration(
                labelText: 'Paste the transcript',
                alignLabelWithHint: true,
                border: OutlineInputBorder(),
                counterText: '',
              ),
              onChanged: (_) => setState(() {}),
            ),
          ],
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(),
          child: const Text('Cancel'),
        ),
        FilledButton(
          onPressed: _isValid ? _submit : null,
          child: const Text('Import'),
        ),
      ],
    );
  }
}
