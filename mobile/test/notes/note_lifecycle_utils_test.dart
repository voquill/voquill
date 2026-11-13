import 'package:app/model/local_note_model.dart';
import 'package:app/utils/note_lifecycle_utils.dart';
import 'package:flutter_test/flutter_test.dart';

void main() {
  group('nextLocalNotePhase', () {
    const valid = {
      (LocalNotePhase.recording, LocalNoteEvent.pause): LocalNotePhase.paused,
      (LocalNotePhase.recording, LocalNoteEvent.stop):
          LocalNotePhase.pendingUpload,
      (LocalNotePhase.paused, LocalNoteEvent.resume): LocalNotePhase.recording,
      (LocalNotePhase.paused, LocalNoteEvent.stop):
          LocalNotePhase.pendingUpload,
      (LocalNotePhase.pendingUpload, LocalNoteEvent.startUpload):
          LocalNotePhase.uploading,
      (LocalNotePhase.pendingUpload, LocalNoteEvent.fail):
          LocalNotePhase.failed,
      (LocalNotePhase.uploading, LocalNoteEvent.uploadInterrupted):
          LocalNotePhase.pendingUpload,
      (LocalNotePhase.uploading, LocalNoteEvent.processAccepted):
          LocalNotePhase.processing,
      (LocalNotePhase.uploading, LocalNoteEvent.fail): LocalNotePhase.failed,
      (LocalNotePhase.processing, LocalNoteEvent.serverReady):
          LocalNotePhase.ready,
      (LocalNotePhase.processing, LocalNoteEvent.fail): LocalNotePhase.failed,
      (LocalNotePhase.failed, LocalNoteEvent.retry):
          LocalNotePhase.pendingUpload,
      (LocalNotePhase.ready, LocalNoteEvent.retry):
          LocalNotePhase.pendingUpload,
      (LocalNotePhase.ready, LocalNoteEvent.resume): LocalNotePhase.recording,
    };

    test('allows exactly the documented transitions', () {
      for (final phase in LocalNotePhase.values) {
        for (final event in LocalNoteEvent.values) {
          expect(
            nextLocalNotePhase(phase, event),
            valid[(phase, event)],
            reason: '$phase + $event',
          );
        }
      }
    });

    test('a full meeting walks recording to ready', () {
      var phase = LocalNotePhase.recording;
      for (final event in [
        LocalNoteEvent.pause,
        LocalNoteEvent.resume,
        LocalNoteEvent.stop,
        LocalNoteEvent.startUpload,
        LocalNoteEvent.uploadInterrupted,
        LocalNoteEvent.startUpload,
        LocalNoteEvent.processAccepted,
        LocalNoteEvent.fail,
        LocalNoteEvent.retry,
        LocalNoteEvent.startUpload,
        LocalNoteEvent.processAccepted,
        LocalNoteEvent.serverReady,
      ]) {
        phase = nextLocalNotePhase(phase, event)!;
      }
      expect(phase, LocalNotePhase.ready);
    });
  });

  group('phaseAfterRestart', () {
    test('re-enters every phase', () {
      const expectedWithoutRecorder = {
        LocalNotePhase.recording: LocalNotePhase.paused,
        LocalNotePhase.paused: LocalNotePhase.paused,
        LocalNotePhase.pendingUpload: LocalNotePhase.pendingUpload,
        LocalNotePhase.uploading: LocalNotePhase.pendingUpload,
        LocalNotePhase.processing: LocalNotePhase.processing,
        LocalNotePhase.ready: LocalNotePhase.ready,
        LocalNotePhase.failed: LocalNotePhase.failed,
      };
      for (final entry in expectedWithoutRecorder.entries) {
        expect(
          phaseAfterRestart(entry.key, isRecorderActive: false),
          entry.value,
          reason: '${entry.key}',
        );
      }
    });

    test('a recording whose native recorder survived keeps recording', () {
      expect(
        phaseAfterRestart(LocalNotePhase.recording, isRecorderActive: true),
        LocalNotePhase.recording,
      );
    });

    test('sync resumes on its own only where no user input is needed', () {
      expect(LocalNotePhase.values.where(localNoteNeedsSync), [
        LocalNotePhase.pendingUpload,
        LocalNotePhase.uploading,
        LocalNotePhase.processing,
        LocalNotePhase.ready,
      ]);
    });
  });
}
