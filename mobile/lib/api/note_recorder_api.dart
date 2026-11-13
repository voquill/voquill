import 'dart:async';

import 'package:flutter/services.dart';

class NoteRecorderState {
  final String noteId;
  final String segmentId;
  final bool isPaused;

  /// Audio captured into the current segment file so far.
  final int segmentElapsedMs;

  const NoteRecorderState({
    required this.noteId,
    required this.segmentId,
    required this.isPaused,
    required this.segmentElapsedMs,
  });

  factory NoteRecorderState.fromMap(Map<dynamic, dynamic> map) =>
      NoteRecorderState(
        noteId: map['noteId'] as String,
        segmentId: map['segmentId'] as String,
        isPaused: map['isPaused'] as bool,
        segmentElapsedMs: (map['segmentElapsedMs'] as num).toInt(),
      );
}

enum NoteRecorderAction { open, stop }

sealed class NoteRecorderEvent {
  const NoteRecorderEvent();
}

/// The native side paused or resumed on its own (interruption, notification).
class NoteRecorderStateEvent extends NoteRecorderEvent {
  final NoteRecorderState state;
  const NoteRecorderStateEvent(this.state);
}

/// The user tapped the Live Activity / notification.
class NoteRecorderActionEvent extends NoteRecorderEvent {
  final NoteRecorderAction action;
  final String noteId;
  const NoteRecorderActionEvent(this.action, this.noteId);
}

/// Bridge to the native meeting recorder (iOS `MeetingRecorder.swift`,
/// Android `NoteRecorder.kt`). Audio is written as ADTS AAC, 16 kHz mono.
class NoteRecorder {
  NoteRecorder() {
    _channel.setMethodCallHandler(_handleNativeCall);
  }

  static const _channel = MethodChannel('com.voquill.mobile/note_recorder');
  final _events = StreamController<NoteRecorderEvent>.broadcast();

  Stream<NoteRecorderEvent> get events => _events.stream;

  Future<void> start({
    required String noteId,
    required String segmentId,
    required String path,
    required int priorElapsedMs,
  }) {
    return _channel.invokeMethod('start', {
      'noteId': noteId,
      'segmentId': segmentId,
      'path': path,
      'priorElapsedMs': priorElapsedMs,
    });
  }

  Future<NoteRecorderState?> pause() => _invokeState('pause');

  Future<NoteRecorderState?> resume() => _invokeState('resume');

  /// Closes the segment file and ends the Live Activity / notification.
  Future<NoteRecorderState?> stop() => _invokeState('stop');

  Future<NoteRecorderState?> getState() => _invokeState('getState');

  /// A Live Activity / notification tap that arrived before Dart listened.
  Future<NoteRecorderActionEvent?> takePendingAction() async {
    final result = await _channel.invokeMethod<Map>('takePendingAction');
    return result == null ? null : _actionFrom(result);
  }

  /// Keeps the process alive while uploads run in the background
  /// (iOS background task, Android data-sync foreground service).
  Future<void> setSyncActive(bool isActive) {
    return _channel.invokeMethod('setSyncActive', {'isActive': isActive});
  }

  Future<NoteRecorderState?> _invokeState(String method) async {
    final result = await _channel.invokeMethod<Map>(method);
    return result == null ? null : NoteRecorderState.fromMap(result);
  }

  NoteRecorderActionEvent _actionFrom(Map<dynamic, dynamic> map) =>
      NoteRecorderActionEvent(
        NoteRecorderAction.values.byName(map['action'] as String),
        map['noteId'] as String,
      );

  Future<dynamic> _handleNativeCall(MethodCall call) async {
    final args = call.arguments as Map;
    switch (call.method) {
      case 'onStateChanged':
        _events.add(NoteRecorderStateEvent(NoteRecorderState.fromMap(args)));
      case 'onAction':
        _events.add(_actionFrom(args));
    }
  }
}
