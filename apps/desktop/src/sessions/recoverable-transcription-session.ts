import type { TranscribeAudioResult } from "../actions/transcribe.actions";
import type { AudioSamples } from "../types/audio.types";
import {
  InterimResultCallback,
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionFinalizeOptions,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { abortable, abortableDelay } from "../utils/abort.utils";
import { getLogger } from "../utils/log.utils";
import { toErrorMessage } from "./streaming-session.utils";

export type RecordedAudioTranscriber = (input: {
  samples: AudioSamples;
  sampleRate: number;
  signal: AbortSignal;
}) => Promise<TranscribeAudioResult>;

export type TranscriptionRecoveryOptions = {
  /** Non-streaming transcription of the whole recording, bound to the dictation's preferences. */
  transcribe: RecordedAudioTranscriber;
  maxAttempts: number;
  retryDelayMs: number;
  /** Null when no total-time cap is safe (local/self-hosted inference, or a transport that watches its own progress). */
  getAttemptTimeoutMs: ((audioDurationMs: number) => number) | null;
};

const DEFAULT_RECOVERY_OPTIONS: Omit<
  TranscriptionRecoveryOptions,
  "transcribe"
> = {
  maxAttempts: 2,
  retryDelayMs: 1_500,
  getAttemptTimeoutMs: null,
};

const CANCELLED_REASON = "Cancelled";

/**
 * The single owner of how a dictation's recording becomes text. With a
 * streaming `inner` session, any failure at start, while streaming or at
 * finalize re-transcribes the full recording returned by `stop_recording`.
 * Without one (batch modes), the recording is transcribed directly. Either
 * way there is one retry policy, timed-out attempts are aborted, and
 * `cleanup()` cancels everything in flight.
 */
export class RecoverableTranscriptionSession implements TranscriptionSession {
  readonly name: string;
  private readonly options: TranscriptionRecoveryOptions;
  private readonly lifetime = new AbortController();
  private startFailureReason: string | null = null;
  private finalizePromise: Promise<TranscriptionSessionResult> | null = null;

  constructor(
    private readonly inner: TranscriptionSession | null,
    options: Partial<TranscriptionRecoveryOptions> &
      Pick<TranscriptionRecoveryOptions, "transcribe">,
  ) {
    this.options = { ...DEFAULT_RECOVERY_OPTIONS, ...options };
    this.name = inner?.name ?? "Batch";
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    try {
      await this.inner?.onRecordingStart(sampleRate);
    } catch (error) {
      this.startFailureReason = `Streaming session failed to start: ${toErrorMessage(error)}`;
      getLogger().warning(`[${this.name}] ${this.startFailureReason}`);
    }
  }

  finalize(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    this.finalizePromise ??= this.runFinalize(audio, options);
    return this.finalizePromise;
  }

  private async runFinalize(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    if (!this.inner) {
      return await this.transcribeRecording(audio, {
        metadata: {},
        warnings: [],
        recovered: false,
      });
    }

    const streamed = await this.finalizeInner(this.inner, audio, options);
    if (!streamed.failureReason || this.lifetime.signal.aborted) {
      return streamed;
    }
    if (streamed.failureCode) {
      getLogger().warning(
        `[${this.name}] not recovering (${streamed.failureCode}): ${streamed.failureReason}`,
      );
      this.inner.cleanup();
      return streamed;
    }

    getLogger().warning(
      `[${this.name}] transcript incomplete, recovering from recorded audio: ${streamed.failureReason}`,
    );
    this.inner.cleanup();
    return await this.transcribeRecording(audio, {
      metadata: streamed.metadata,
      warnings: [
        ...streamed.warnings,
        `Transcript incomplete (${streamed.failureReason}); re-transcribed the recorded audio`,
      ],
      recovered: true,
    });
  }

  cleanup(): void {
    this.lifetime.abort();
    this.inner?.cleanup();
  }

  supportsStreaming(): boolean {
    return this.inner?.supportsStreaming() ?? false;
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.inner?.setInterimResultCallback(callback);
  }

  private async finalizeInner(
    inner: TranscriptionSession,
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
      return await inner.finalize(audio, options);
    } catch (error) {
      return {
        rawTranscript: null,
        metadata: {},
        warnings: [],
        failureReason: toErrorMessage(error),
      };
    }
  }

  private async transcribeRecording(
    audio: StopRecordingResponse,
    context: Pick<TranscriptionSessionResult, "metadata" | "warnings"> & {
      recovered: boolean;
    },
  ): Promise<TranscriptionSessionResult> {
    const warnings = [...context.warnings];
    const sampleRate = audio.sampleRate ?? 0;
    const sampleCount = audio.samples?.length ?? 0;
    if (sampleRate <= 0 || sampleCount === 0) {
      getLogger().warning(`[${this.name}] no recorded audio to transcribe`);
      return { rawTranscript: null, metadata: context.metadata, warnings };
    }

    const timeoutMs = this.options.getAttemptTimeoutMs?.(
      (sampleCount / sampleRate) * 1000,
    );
    let failureReason = "Transcription failed";

    for (let attempt = 1; attempt <= this.options.maxAttempts; attempt++) {
      try {
        const result = await this.runAttempt(audio, sampleRate, timeoutMs);
        getLogger().info(
          `[${this.name}] transcription attempt ${attempt} succeeded (${result.rawTranscript.length} chars)`,
        );
        return {
          rawTranscript: result.rawTranscript || null,
          metadata: result.metadata,
          warnings: [...warnings, ...result.warnings],
          ...(context.recovered ? { recovered: true } : {}),
        };
      } catch (error) {
        if (this.lifetime.signal.aborted) {
          return this.cancelled(context.metadata, warnings);
        }
        failureReason = toErrorMessage(error);
        warnings.push(
          `Transcription attempt ${attempt} failed: ${failureReason}`,
        );
        getLogger().warning(
          `[${this.name}] transcription attempt ${attempt}/${this.options.maxAttempts} failed: ${failureReason}`,
        );
      }

      if (attempt < this.options.maxAttempts) {
        try {
          await abortableDelay(
            this.options.retryDelayMs * attempt,
            this.lifetime.signal,
          );
        } catch {
          return this.cancelled(context.metadata, warnings);
        }
      }
    }

    return {
      rawTranscript: null,
      metadata: context.metadata,
      warnings,
      failureReason,
    };
  }

  private async runAttempt(
    audio: StopRecordingResponse,
    sampleRate: number,
    timeoutMs: number | undefined,
  ): Promise<TranscribeAudioResult> {
    const attempt = new AbortController();
    const cancel = () => attempt.abort();
    this.lifetime.signal.addEventListener("abort", cancel, { once: true });
    let timedOut = false;
    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          attempt.abort();
        }, timeoutMs)
      : null;

    try {
      return await abortable(
        this.options.transcribe({
          samples: audio.samples,
          sampleRate,
          signal: attempt.signal,
        }),
        attempt.signal,
      );
    } catch (error) {
      if (timedOut && timeoutMs) {
        throw new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`);
      }
      throw error;
    } finally {
      if (timer) clearTimeout(timer);
      this.lifetime.signal.removeEventListener("abort", cancel);
    }
  }

  private cancelled(
    metadata: TranscriptionSessionResult["metadata"],
    warnings: string[],
  ): TranscriptionSessionResult {
    return {
      rawTranscript: null,
      metadata,
      warnings,
      failureReason: CANCELLED_REASON,
    };
  }
}
