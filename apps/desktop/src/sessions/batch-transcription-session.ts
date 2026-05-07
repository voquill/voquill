import { showErrorSnackbar } from "../actions/app.actions";
import { transcribeAudio } from "../actions/transcribe.actions";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";

/**
 * Batch transcription session - records audio first, then transcribes all at once.
 * Only handles transcription, not post-processing.
 */
export class BatchTranscriptionSession implements TranscriptionSession {
  async onRecordingStart(_sampleRate: number): Promise<void> {
    // No-op for batch transcription - we process after recording stops
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const payloadSamples = Array.isArray(audio.samples)
      ? audio.samples
      : Array.from(audio.samples ?? []);
    const rate = audio.sampleRate;

    if (rate == null || rate <= 0 || payloadSamples.length === 0) {
      const reason =
        rate == null || rate <= 0
          ? "invalid sample rate"
          : "no audio samples captured";
      getLogger().warning(
        `Batch session: cannot transcribe - ${reason} (rate=${rate}, samples=${payloadSamples.length})`,
      );
      showErrorSnackbar(
        rate == null || rate <= 0
          ? "Recording failed: invalid audio format. Please check your microphone."
          : "No audio was captured. Please check your microphone is working and try again.",
      );
      return {
        rawTranscript: null,
        metadata: {},
        warnings: ["Recording produced no usable audio"],
      };
    }

    const warnings: string[] = [];

    try {
      getLogger().info(
        `Batch transcription: ${payloadSamples.length} samples at ${rate}Hz`,
      );
      const result = await transcribeAudio({
        samples: payloadSamples,
        sampleRate: rate,
      });

      getLogger().info(
        `Batch transcription result: ${result.rawTranscript.length} chars`,
      );
      return {
        rawTranscript: result.rawTranscript,
        metadata: result.metadata,
        warnings: [...warnings, ...result.warnings],
      };
    } catch (error) {
      getLogger().error(`Failed to transcribe audio: ${error}`);
      const message =
        error instanceof Error
          ? error.message
          : "Unable to transcribe audio. Please try again.";
      if (message) {
        warnings.push(`Transcription failed: ${message}`);
        showErrorSnackbar(message);
      }

      return {
        rawTranscript: null,
        metadata: {},
        warnings,
      };
    }
  }

  cleanup(): void {
    // No-op for batch transcription
  }
}
