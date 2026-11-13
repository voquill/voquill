import 'dart:async';

import 'package:flutter/services.dart';

/// Why the native recorder changed state on its own.
enum NoteRecorderReason {
  /// A call, Siri or another app took the audio session.
  interruption,

  /// The segment reached its duration/size cap; recording continues in a
  /// new segment file ([NoteRecorderState.segmentId] is the new one).
  rollover,

  /// The note reached its duration cap; recording is paused.
  limit,

  /// Writing failed (storage full); the session ended, the file is kept.
  writeFailed,

  /// The microphone failed; the session ended, the file is kept.
  error,

  /// Paused or resumed from the notification.
  user,

  /// [NoteRecorderState.isSilent] changed.
  silence,
}

class NoteRecorderState {
  final String noteId;
  final String segmentId;
  final bool isPaused;

  /// Audio captured into the current segment file so far.
  final int segmentElapsedMs;
  final NoteRecorderReason? reason;

  /// Only silence has been captured for a while.
  final bool isSilent;

  const NoteRecorderState({
    required this.noteId,
    required this.segmentId,
    required this.isPaused,
    required this.segmentElapsedMs,
    this.reason,
    this.isSilent = false,
  });

  factory NoteRecorderState.fromMap(Map<dynamic, dynamic> map) =>
      NoteRecorderState(
        noteId: map['noteId'] as String,
        segmentId: map['segmentId'] as String,
        isPaused: map['isPaused'] as bool,
        segmentElapsedMs: (map['segmentElapsedMs'] as num).toInt(),
        isSilent: map['isSilent'] as bool? ?? false,
        reason: switch (map['reason']) {
          'interruption' => NoteRecorderReason.interruption,
          'rollover' => NoteRecorderReason.rollover,
          'limit' => NoteRecorderReason.limit,
          'write_failed' => NoteRecorderReason.writeFailed,
          'error' => NoteRecorderReason.error,
          'user' => NoteRecorderReason.user,
          'silence' => NoteRecorderReason.silence,
          _ => null,
        },
      );
}

/// Native error code when free storage is too low to record.
const noteRecorderLowStorageCode = 'LOW_STORAGE';

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
    required int maxSegmentMs,
    required int maxSegmentBytes,
    required int maxNoteMs,
  }) {
    return _channel.invokeMethod('start', {
      'noteId': noteId,
      'segmentId': segmentId,
      'path': path,
      'priorElapsedMs': priorElapsedMs,
      'maxSegmentMs': maxSegmentMs,
      'maxSegmentBytes': maxSegmentBytes,
      'maxNoteMs': maxNoteMs,
    });
  }

  Future<int> freeBytes(String path) async {
    final result = await _channel.invokeMethod<num>('freeBytes', {
      'path': path,
    });
    return result?.toInt() ?? 0;
  }

  /// Keeps meeting audio and notes out of iCloud backups (Android excludes
  /// them through the manifest's backup rules).
  Future<void> excludeFromBackup(String path) {
    return _channel.invokeMethod('excludeFromBackup', {'path': path});
  }

  /// False on Android 9 and older, where only one recorder can hold the
  /// microphone, so dictation cannot run while a meeting records.
  Future<bool> canShareMicrophone() async {
    return await _channel.invokeMethod<bool>('canShareMicrophone') ?? true;
  }

  Future<NoteRecorderState?> pause() => _invokeState('pause');

  Future<NoteRecorderState?> resume() => _invokeState('resume');

  /// Closes the segment file and ends the Live Activity / notification.
  Future<NoteRecorderState?> stop() => _invokeState('stop');

  Future<NoteRecorderState?> getState() => _invokeState('getState');

  NoteRecorderActionEvent? _unheardAction;

  /// A Live Activity / notification tap that arrived before Notes listened
  /// (natively, or here while nothing was subscribed yet).
  Future<NoteRecorderActionEvent?> takePendingAction() async {
    final unheard = _unheardAction;
    _unheardAction = null;
    final result = await _channel.invokeMethod<Map>('takePendingAction');
    return unheard ?? (result == null ? null : _actionFrom(result));
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
        final action = _actionFrom(args);
        if (_events.hasListener) {
          _events.add(action);
        } else {
          _unheardAction = action;
        }
    }
  }
}
