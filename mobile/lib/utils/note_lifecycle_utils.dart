import 'package:app/model/local_note_model.dart';

enum LocalNoteEvent {
  pause,
  resume,
  stop,
  startUpload,
  uploadInterrupted,
  processAccepted,
  serverReady,
  fail,
  retry,
}

const _transitions = <LocalNotePhase, Map<LocalNoteEvent, LocalNotePhase>>{
  LocalNotePhase.recording: {
    LocalNoteEvent.pause: LocalNotePhase.paused,
    LocalNoteEvent.stop: LocalNotePhase.pendingUpload,
  },
  LocalNotePhase.paused: {
    LocalNoteEvent.resume: LocalNotePhase.recording,
    LocalNoteEvent.stop: LocalNotePhase.pendingUpload,
  },
  LocalNotePhase.pendingUpload: {
    LocalNoteEvent.startUpload: LocalNotePhase.uploading,
    LocalNoteEvent.fail: LocalNotePhase.failed,
  },
  LocalNotePhase.uploading: {
    LocalNoteEvent.uploadInterrupted: LocalNotePhase.pendingUpload,
    LocalNoteEvent.processAccepted: LocalNotePhase.processing,
    LocalNoteEvent.fail: LocalNotePhase.failed,
  },
  LocalNotePhase.processing: {
    LocalNoteEvent.serverReady: LocalNotePhase.ready,
    LocalNoteEvent.fail: LocalNotePhase.failed,
  },
  LocalNotePhase.failed: {LocalNoteEvent.retry: LocalNotePhase.pendingUpload},
  LocalNotePhase.ready: {},
};

/// The next phase for [event], or null when [event] is not valid in [phase].
LocalNotePhase? nextLocalNotePhase(LocalNotePhase phase, LocalNoteEvent event) {
  return _transitions[phase]?[event];
}

/// Where a persisted note re-enters after the app process restarted.
/// A capture whose native recorder is gone comes back paused; an upload that
/// was cut off goes back to the queue. Every other phase resumes as is.
LocalNotePhase phaseAfterRestart(
  LocalNotePhase phase, {
  required bool isRecorderActive,
}) {
  switch (phase) {
    case LocalNotePhase.recording:
      return isRecorderActive ? phase : LocalNotePhase.paused;
    case LocalNotePhase.uploading:
      return LocalNotePhase.pendingUpload;
    case LocalNotePhase.paused:
    case LocalNotePhase.pendingUpload:
    case LocalNotePhase.processing:
    case LocalNotePhase.ready:
    case LocalNotePhase.failed:
      return phase;
  }
}

/// Phases in which the sync engine has work to do without user input.
bool localNoteNeedsSync(LocalNotePhase phase) {
  switch (phase) {
    case LocalNotePhase.pendingUpload:
    case LocalNotePhase.uploading:
    case LocalNotePhase.processing:
    case LocalNotePhase.ready:
      return true;
    case LocalNotePhase.recording:
    case LocalNotePhase.paused:
    case LocalNotePhase.failed:
      return false;
  }
}
