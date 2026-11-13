import type { TranscribeAudioMetadata } from "../actions/transcribe.actions";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import { abortable, withTimeout } from "../utils/abort.utils";
import {
  AudioChunkRelay,
  RELAY_MAX_BUFFERED_SECONDS,
  toErrorMessage,
} from "./streaming-session.utils";

export type PushStream = {
  writeAudioChunk: (samples: Float32Array) => void;
  cleanup: () => void;
};

/**
 * A provider SDK stream that audio is pushed into (Azure, local sidecar).
 * Owns buffering until the stream exists, cancellation of a late start, and
 * reporting `failureReason` instead of a partial transcript.
 */
export abstract class PushStreamTranscriptionSession<
  S extends PushStream,
> implements TranscriptionSession {
  abstract readonly name: string;
  protected abstract readonly metadata: TranscribeAudioMetadata;
  /** Null waits as long as stream creation takes (e.g. local model load). */
  protected abstract readonly connectTimeoutMs: number | null;

  protected abstract createStream(sampleRate: number): Promise<S>;
  protected abstract finishStream(
    stream: S,
  ): Promise<TranscriptionSessionResult>;

  protected failureReason: string | null = null;
  private stream: S | null = null;
  private relay: AudioChunkRelay | null = null;
  private startPromise: Promise<void> | null = null;
  private readonly lifetime = new AbortController();

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.startPromise ??= this.start(sampleRate);
    await this.startPromise;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    await this.startPromise;
    const stream = this.stream;
    this.relay?.stop();
    if (!stream || this.failureReason) {
      return this.failure(
        this.failureReason ?? `${this.name} streaming session was not started`,
      );
    }

    try {
      const result = await abortable(
        this.finishStream(stream),
        this.lifetime.signal,
      );
      return this.failureReason ? this.failure(this.failureReason) : result;
    } catch (error) {
      return this.failure(
        this.failureReason ??
          `${this.name} streaming transcription failed (${toErrorMessage(error)})`,
      );
    } finally {
      this.release();
    }
  }

  cleanup(): void {
    this.fail("Stream closed");
    this.release();
  }

  protected fail(reason: string): void {
    if (this.failureReason) {
      return;
    }
    this.failureReason = reason;
    getLogger().warning(`[${this.name}] ${reason}`);
    this.relay?.stop();
    this.lifetime.abort();
  }

  private async start(sampleRate: number): Promise<void> {
    try {
      const relay = await AudioChunkRelay.start({
        maxBufferedSamples: sampleRate * RELAY_MAX_BUFFERED_SECONDS,
        onOverflow: () =>
          this.fail(
            `${this.name} not ready after ${RELAY_MAX_BUFFERED_SECONDS}s of audio`,
          ),
      });
      if (this.failureReason) {
        relay.stop();
        return;
      }
      this.relay = relay;

      const creation = this.createStream(sampleRate);
      const stream = await (
        this.connectTimeoutMs
          ? withTimeout(creation, this.connectTimeoutMs, this.lifetime.signal)
          : abortable(creation, this.lifetime.signal)
      ).catch((error) => {
        creation.then((late) => late.cleanup()).catch(() => {});
        throw error;
      });

      this.stream = stream;
      relay.pipeTo((samples) => {
        try {
          stream.writeAudioChunk(samples);
        } catch (error) {
          this.fail(`Failed to write audio: ${toErrorMessage(error)}`);
        }
      });
      getLogger().info(`[${this.name}] stream ready`);
    } catch (error) {
      this.fail(
        this.failureReason ??
          `${this.name} streaming session was not established: ${toErrorMessage(error)}`,
      );
    }
  }

  private release(): void {
    this.relay?.stop();
    this.relay = null;
    this.stream?.cleanup();
    this.stream = null;
  }

  protected failure(failureReason: string): TranscriptionSessionResult {
    return {
      rawTranscript: null,
      metadata: this.metadata,
      warnings: [],
      failureReason,
    };
  }
}
