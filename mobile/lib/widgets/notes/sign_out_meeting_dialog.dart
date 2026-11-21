import 'package:app/store/store.dart';
import 'package:app/utils/theme_utils.dart';
import 'package:app/widgets/common/app_dialog.dart';
import 'package:flutter/material.dart';

/// Signing out stops a recording meeting; ask first. Resolves true when
/// signing out may continue.
Future<bool> confirmSignOutDuringMeeting(BuildContext context) async {
  if (getAppState().notes.liveNote == null) return true;
  final confirmed = await showDialog<bool>(
    context: context,
    builder: (context) => AppDialog(
      title: const Text('Stop your meeting?'),
      content: Padding(
        padding: Theming.padding.onlyHorizontal(),
        child: const Text(
          'A meeting is being recorded. Signing out stops it. Everything recorded stays on this device and uploads when you sign back in.',
        ),
      ),
      actions: [
        TextButton(
          onPressed: () => Navigator.of(context).pop(false),
          child: const Text('Keep recording'),
        ),
        FilledButton(
          onPressed: () => Navigator.of(context).pop(true),
          child: const Text('Sign out'),
        ),
      ],
    ),
  );
  return confirmed ?? false;
}
