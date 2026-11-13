import 'package:app/utils/note_utils.dart';
import 'package:app/widgets/notes/note_elapsed_text.dart';
import 'package:flutter/material.dart';

/// Small status for list rows and banners: a live dot with ticking time while
/// recording, plain words for everything else.
class NoteStateLabel extends StatelessWidget {
  const NoteStateLabel({super.key, required this.view});

  final NoteView view;

  @override
  Widget build(BuildContext context) {
    final theme = Theme.of(context);
    final style = theme.textTheme.labelMedium;
    final muted = theme.colorScheme.onSurface.withValues(alpha: 0.6);

    switch (view.state) {
      case NoteDisplayState.recording:
        return Row(
          mainAxisSize: MainAxisSize.min,
          children: [
            const LiveDot(),
            const SizedBox(width: 6),
            NoteElapsedText(
              view: view,
              style: style?.copyWith(color: theme.colorScheme.error),
            ),
          ],
        );
      case NoteDisplayState.uploading:
        final progress = view.uploadProgress;
        return Text(
          progress == null
              ? 'Uploading'
              : 'Uploading ${(progress * 100).round()}%',
          style: style?.copyWith(color: muted),
        );
      case NoteDisplayState.failed:
        return Text(
          'Failed',
          style: style?.copyWith(color: theme.colorScheme.error),
        );
      case NoteDisplayState.ready:
        return view.failedSegmentError == null
            ? const SizedBox.shrink()
            : Icon(
                Icons.error_outline,
                size: 18,
                color: theme.colorScheme.error,
              );
      case NoteDisplayState.paused:
      case NoteDisplayState.waitingForConnection:
      case NoteDisplayState.queued:
      case NoteDisplayState.processing:
      case NoteDisplayState.draft:
        return Text(
          noteStateText(view.state),
          style: style?.copyWith(color: muted),
        );
    }
  }
}

String noteStateText(NoteDisplayState state) {
  switch (state) {
    case NoteDisplayState.recording:
      return 'Recording';
    case NoteDisplayState.paused:
      return 'Paused';
    case NoteDisplayState.waitingForConnection:
      return 'Waiting for connection';
    case NoteDisplayState.queued:
      return 'Queued';
    case NoteDisplayState.uploading:
      return 'Uploading';
    case NoteDisplayState.processing:
      return 'Processing';
    case NoteDisplayState.failed:
      return 'Failed';
    case NoteDisplayState.ready:
      return 'Ready';
    case NoteDisplayState.draft:
      return 'Not processed';
  }
}

class LiveDot extends StatelessWidget {
  const LiveDot({super.key, this.size = 8});

  final double size;

  @override
  Widget build(BuildContext context) {
    return Container(
      width: size,
      height: size,
      decoration: BoxDecoration(
        color: Theme.of(context).colorScheme.error,
        shape: BoxShape.circle,
      ),
    );
  }
}
