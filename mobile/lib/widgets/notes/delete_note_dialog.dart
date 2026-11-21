import 'package:app/widgets/common/app_dialog.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:flutter/material.dart';

/// Explicit confirmation before a note (and any audio on this device) is
/// deleted. Resolves true when the user confirmed.
Future<bool> confirmDeleteNote(
  BuildContext context, {
  required String title,
}) async {
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) {
      final theme = Theme.of(context);
      return AppDialog(
        title: const Text('Delete note?'),
        content: Padding(
          padding: Theming.padding.onlyHorizontal(),
          child: Text(
            '"$title" will be deleted from all your devices, including its recording, transcript and notes. This cannot be undone.',
          ),
        ),
        actions: [
          TextButton(
            onPressed: () => Navigator.of(context).pop(false),
            child: const Text('Cancel'),
          ),
          FilledButton(
            onPressed: () => Navigator.of(context).pop(true),
            style: FilledButton.styleFrom(
              backgroundColor: theme.colorScheme.error,
              foregroundColor: theme.colorScheme.onError,
            ),
            child: const Text('Delete'),
          ),
        ],
      );
    },
  );
  return confirmed ?? false;
}
