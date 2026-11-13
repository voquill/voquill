import { delayed } from "@voquill/utilities";
import { transcribeAudio } from "../actions/transcribe.actions";
import {
  InterimResultCallback,
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionFinalizeOptions,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import { toErrorMessage, withTimeout } from "./streaming-session.utils";

export type TranscriptionRecoveryOptions = {
  maxAttempts: number;
  retryDelayMs: number;
  /** Null disables the per-attempt timeout (local inference cannot hang on a network). */
  getAttemptTimeoutMs: ((audioDurationMs: number) => number) | null;
  transcribe: typeof transcribeAudio;
};

const DEFAULT_RECOVERY_OPTIONS: TranscriptionRecoveryOptions = {
  maxAttempts: 2,
  retryDelayMs: 1_500,
  getAttemptTimeoutMs: null,
  transcribe: transcribeAudio,
};

/**
 * Wraps any transcription session so a failure at any stage (start, stream,
 * finalize) re-transcribes the full recording returned by `stop_recording`
 * through the configured non-streaming path, instead of losing the audio.
 */
export class RecoverableTranscriptionSession implements TranscriptionSession {
  private readonly options: TranscriptionRecoveryOptions;
  private startFailureReason: string | null = null;

  constructor(
    private readonly inner: TranscriptionSession,
    options: Partial<TranscriptionRecoveryOptions> = {},
  ) {
    this.options = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
  }

  get sessionName(): string {
    return this.inner.constructor.name;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    try {
      await this.inner.onRecordingStart(sampleRate);
    } catch (error) {
      this.startFailureReason = `Streaming session failed to start: ${toErrorMessage(error)}`;
      getLogger().warning(`[${this.sessionName}] ${this.startFailureReason}`);
    }
  }

  async finalize(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    const result = await this.finalizeInner(audio, options);
    if (!result.failureReason) {
      return result;
    }

    getLogger().warning(
      `[${this.sessionName}] transcript incomplete, recovering from recorded audio: ${result.failureReason}`,
    );
    this.inner.cleanup();
    return await this.recover(audio, result);
  }

  cleanup(): void {
    this.inner.cleanup();
  }

  supportsStreaming(): boolean {
    return this.inner.supportsStreaming();
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.inner.setInterimResultCallback(callback);
  }

  private async finalizeInner(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    if (this.startFailureReason) {
      return {
        rawTranscript: null,
        metadata: {},
        warnings: [],
        failureReason: this.startFailureReason,
      };
    }

    try {
      return await this.inner.finalize(audio, options);
    } catch (error) {
      return {
        rawTranscript: null,
        metadata: {},
        warnings: [],
        failureReason: toErrorMessage(error),
      };
    }
  }

  private async recover(
    audio: StopRecordingResponse,
    failed: TranscriptionSessionResult,
  ): Promise<TranscriptionSessionResult> {
    const warnings = [
      ...failed.warnings,
      `Transcript incomplete (${failed.failureReason}); re-transcribed the recorded audio`,
    ];
    const sampleRate = audio.sampleRate ?? 0;
    const sampleCount = audio.samples?.length ?? 0;
    if (sampleRate <= 0 || sampleCount === 0) {
      getLogger().warning(`[${this.sessionName}] no recorded audio to recover`);
      return { rawTranscript: null, metadata: failed.metadata, warnings };
    }

    const audioDurationMs = (sampleCount / sampleRate) * 1000;
    const timeoutMs = this.options.getAttemptTimeoutMs?.(audioDurationMs);
    let failureReason = failed.failureReason ?? "Transcription failed";

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        const transcription = this.options.transcribe({
          samples: audio.samples,
          sampleRate,
        });
        const result = timeoutMs
          ? await withTimeout(transcription, timeoutMs)
          : await transcription;

        getLogger().info(
          `[${this.sessionName}] recovery attempt ${attempt} succeeded (${result.rawTranscript.length} chars)`,
        );
        return {
          rawTranscript: result.rawTranscript || null,
          metadata: result.metadata,
          warnings: [...warnings, ...result.warnings],
          recovered: true,
        };
      } catch (error) {
        failureReason = toErrorMessage(error);
        warnings.push(`Recovery attempt ${attempt} failed: ${failureReason}`);
        getLogger().warning(
          `[${this.sessionName}] recovery attempt ${attempt}/${this.options.maxAttempts} failed: ${failureReason}`,
        );
        if (attempt < this.options.maxAttempts) {
          await delayed(this.options.retryDelayMs * attempt);
        }
      }
    }

    return {
      rawTranscript: null,
      metadata: failed.metadata,
      warnings,
      failureReason,
    };
  }
}
