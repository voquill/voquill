import 'package:app/utils/note_utils.dart';
import 'package:flutter/material.dart';

/// Short name of a note's state, for chips.
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
