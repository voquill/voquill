import { transcribeAudio } from "../actions/transcribe.actions";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import { getTranscriptionTimeoutMs } from "../utils/transcribe.utils";
import { toErrorMessage, withTimeout } from "./streaming-session.utils";

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
    const sampleCount = audio.samples?.length ?? 0;
    const rate = audio.sampleRate;

    if (rate == null || rate <= 0 || sampleCount === 0) {
      getLogger().warning(
        `Batch session: skipping transcription (rate=${rate}, samples=${sampleCount})`,
      );
      return {
        rawTranscript: null,
        metadata: {},
        warnings: [],
      };
    }

    try {
      getLogger().info(
        `Batch transcription: ${sampleCount} samples at ${rate}Hz`,
      );
      const timeoutMs = getTranscriptionTimeoutMs((sampleCount / rate) * 1000);
      const result = await withTimeout(
        transcribeAudio({ samples: audio.samples, sampleRate: rate }),
        timeoutMs,
      );

      getLogger().info(
        `Batch transcription result: ${result.rawTranscript.length} chars`,
      );
      return {
        rawTranscript: result.rawTranscript,
        metadata: result.metadata,
        warnings: result.warnings,
      };
    } catch (error) {
      getLogger().error(`Failed to transcribe audio: ${error}`);
      return {
        rawTranscript: null,
        metadata: {},
        warnings: [],
        failureReason: `Transcription failed: ${toErrorMessage(error)}`,
      };
    }
  }

  cleanup(): void {}

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}
}
