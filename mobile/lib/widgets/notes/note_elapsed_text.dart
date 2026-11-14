import 'dart:async';

import 'package:app/utils/note_utils.dart';
import 'package:flutter/material.dart';

/// A note's audio duration; ticks every second while it is recording.
class NoteElapsedText extends StatefulWidget {
  const NoteElapsedText({super.key, required this.view, this.style});

  final NoteView view;
  final TextStyle? style;

  @override
  State<NoteElapsedText> createState() => _NoteElapsedTextState();
}

class _NoteElapsedTextState extends State<NoteElapsedText> {
  Timer? _timer;

  @override
  void initState() {
    super.initState();
    _syncTimer();
  }

  @override
  void didUpdateWidget(NoteElapsedText oldWidget) {
    super.didUpdateWidget(oldWidget);
    _syncTimer();
  }

  void _syncTimer() {
    final isRecording = widget.view.state == NoteDisplayState.recording;
    if (isRecording && _timer == null) {
      _timer = Timer.periodic(
        const Duration(seconds: 1),
        (_) => setState(() {}),
      );
    } else if (!isRecording) {
      _timer?.cancel();
      _timer = null;
    }
  }

  @override
  void dispose() {
    _timer?.cancel();
    super.dispose();
  }

  @override
  Widget build(BuildContext context) {
    return Text(
      formatNoteDuration(widget.view.durationMs(DateTime.now())),
      style: (widget.style ?? const TextStyle()).copyWith(
        fontFeatures: const [FontFeature.tabularFigures()],
      ),
    );
  }
}
