import type { TranscribeAudioMetadata } from "../actions/transcribe.actions";
import {
  InterimResultCallback,
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionFinalizeOptions,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import {
  closeSocket,
  getAbnormalCloseFailure,
  STREAM_CONNECT_TIMEOUT_MS,
  waitForUploadDrain,
} from "../utils/websocket.utils";
import {
  AudioChunkRelay,
  RELAY_MAX_BUFFERED_SECONDS,
  toErrorMessage,
} from "./streaming-session.utils";

type WebSocketPayload = string | ArrayBufferLike | ArrayBufferView;

export type AudioChunking = {
  minDurationMs: number;
  maxDurationMs: number;
};

/**
 * One provider WebSocket for one recording. Subclasses supply the protocol;
 * this class owns buffering, chunking, readiness, cancellation, upload drain
 * and the rule that any problem settles the session with a `failureReason`
 * rather than a partial transcript.
 */
export abstract class WebSocketTranscriptionSession implements TranscriptionSession {
  abstract readonly name: string;
  protected abstract readonly metadata: TranscribeAudioMetadata;
  /** Null sends each recorder chunk as-is. */
  protected abstract readonly chunking: AudioChunking | null;
  /** Close after the finalize request means "done" (vs. "dropped"). */
  protected abstract readonly closeCompletesFinalize: boolean;

  protected abstract openSocket(
    sampleRate: number,
    signal: AbortSignal,
  ): Promise<WebSocket>;
  protected abstract encodeAudio(
    samples: Float32Array,
    isFinal: boolean,
  ): WebSocketPayload;
  protected abstract handleMessage(data: unknown): void;
  protected abstract sendFinalizeRequest(
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<void> | void;
  protected abstract getFinalizeTimeoutMs(
    options?: TranscriptionSessionFinalizeOptions,
  ): number;
  protected abstract buildResult(): Omit<
    TranscriptionSessionResult,
    "metadata" | "warnings"
  > &
    Partial<Pick<TranscriptionSessionResult, "metadata">>;

  protected sampleRate = 0;
  protected isFinalizing = false;
  private interimCallback: InterimResultCallback | null = null;
  private ws: WebSocket | null = null;
  private relay: AudioChunkRelay | null = null;
  private startPromise: Promise<void> | null = null;
  private resolveReady: (() => void) | null = null;
  private isReady = false;
  private isDone = false;
  private failureReason: string | null = null;
  private result: TranscriptionSessionResult | null = null;
  private resolveFinalize:
    | ((result: TranscriptionSessionResult) => void)
    | null = null;
  private readonly lifetime = new AbortController();
  private finalizeTimer: ReturnType<typeof setTimeout> | null = null;
  private finalizeStartedAt = 0;
  private pendingChunks: Float32Array[] = [];
  private pendingSampleCount = 0;
  private sentChunkCount = 0;
  private lastBufferedAmount = 0;
  private hasObservedDrain = false;
  private lastMessageAt = 0;

  supportsStreaming(): boolean {
    return true;
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.interimCallback = callback;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.sampleRate = sampleRate;
    this.startPromise ??= this.start();
    await this.startPromise;
  }

  async finalize(
    _audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    if (!this.startPromise) {
      return this.fail(`${this.name} streaming session was not started`);
    }
    await this.startPromise;
    if (this.isDone) {
      return this.settledResult();
    }

    this.isFinalizing = true;
    this.finalizeStartedAt = Date.now();
    this.relay?.stop();
    const settled = new Promise<TranscriptionSessionResult>((resolve) => {
      this.resolveFinalize = resolve;
    });

    try {
      this.flushPending(true);
      await this.sendFinalizeRequest(options);
    } catch (error) {
      return this.fail(`Failed to finalize: ${toErrorMessage(error)}`);
    }
    if (this.isDone) {
      return this.settledResult();
    }

    const ws = this.ws;
    if (ws) {
      waitForUploadDrain({
        ws,
        armed: this.hasObservedDrain,
        getLastMessageAt: () => this.lastMessageAt,
        signal: this.lifetime.signal,
      }).then(
        () => this.startFinalizeTimer(options),
        (error) => this.fail(toErrorMessage(error)),
      );
    }
    return await settled;
  }

  cleanup(): void {
    this.fail("Stream closed");
  }

  protected markReady(): void {
    if (this.isReady || this.isDone) {
      return;
    }
    this.isReady = true;
    getLogger().info(`[${this.name}] stream ready`);
    this.resolveReady?.();
    this.relay?.pipeTo((samples) => this.enqueueAudio(samples));
  }

  protected emitInterim(segment: string): void {
    if (!this.isDone && segment) {
      this.interimCallback?.(segment);
    }
  }

  protected send(payload: WebSocketPayload): void {
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      throw new Error("Connection is not open");
    }
    ws.send(payload);
  }

  /** Sends a final audio chunk of silence, for protocols that need one. */
  protected sendFinalSilence(): void {
    const minSamples = this.getChunkSampleCounts()?.min ?? 1;
    this.send(this.encodeAudio(new Float32Array(minSamples), true));
  }

  protected complete(): void {
    if (this.isDone || !this.isFinalizing) {
      return;
    }
    const result = this.buildResult();
    this.settle({
      ...result,
      metadata: {
        ...this.metadata,
        ...result.metadata,
        transcriptionDurationMs:
          result.metadata?.transcriptionDurationMs ??
          Date.now() - this.finalizeStartedAt,
      },
      warnings: [],
    });
  }

  protected fail(reason: string): TranscriptionSessionResult {
    if (!this.isDone) {
      this.failureReason = reason;
      getLogger().warning(
        `[${this.name}] ${reason} (ready=${this.isReady}, finalizing=${this.isFinalizing}, sent=${this.sentChunkCount})`,
      );
      this.settle({
        rawTranscript: null,
        metadata: this.metadata,
        warnings: [],
        failureReason: reason,
      });
    }
    return this.settledResult();
  }

  /** Called when the provider has not finished after the finalize request. */
  protected onFinalizeTimeout(timeoutMs: number): void {
    this.fail(`${this.name} did not finish within ${timeoutMs / 1000}s`);
  }

  private async start(): Promise<void> {
    const ready = new Promise<void>((resolve) => {
      this.resolveReady = resolve;
    });
    const connectTimer = setTimeout(
      () =>
        this.fail(
          `${this.name} not ready within ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`,
        ),
      STREAM_CONNECT_TIMEOUT_MS,
    );

    try {
      const relay = await AudioChunkRelay.start({
        maxBufferedSamples: this.sampleRate * RELAY_MAX_BUFFERED_SECONDS,
        onOverflow: () =>
          this.fail(
            `${this.name} not ready after ${RELAY_MAX_BUFFERED_SECONDS}s of audio`,
          ),
      });
      if (this.isDone) {
        relay.stop();
        return;
      }
      this.relay = relay;

      const ws = await this.openSocket(this.sampleRate, this.lifetime.signal);
      if (this.isDone) {
        closeSocket(ws);
        return;
      }
      this.attachSocket(ws);
      await ready;
    } catch (error) {
      this.fail(
        `${this.name} streaming session was not established: ${toErrorMessage(error)}`,
      );
    } finally {
      clearTimeout(connectTimer);
    }
  }

  private attachSocket(ws: WebSocket): void {
    this.ws = ws;
    ws.onopen = () => {
      try {
        this.onSocketOpen();
      } catch (error) {
        this.fail(toErrorMessage(error));
      }
    };
    ws.onmessage = (event: MessageEvent) => {
      if (this.isDone) {
        return;
      }
      this.lastMessageAt = Date.now();
      try {
        this.handleMessage(event.data);
      } catch (error) {
        getLogger().error(`[${this.name}] Failed to handle message: ${error}`);
      }
    };
    ws.onerror = () => {
      this.fail(
        this.isReady ? "WebSocket error" : "WebSocket connection failed",
      );
    };
    ws.onclose = (event: CloseEvent) => {
      const abnormalClose = getAbnormalCloseFailure(event);
      if (this.isFinalizing && this.closeCompletesFinalize && !abnormalClose) {
        this.complete();
        return;
      }
      this.fail(
        abnormalClose ??
          `Connection closed ${this.isFinalizing ? "before the final transcript" : "during recording"} (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`,
      );
    };
  }

  /** Ready on open by default; protocols with a handshake override this. */
  protected onSocketOpen(): void {
    this.markReady();
  }

  private enqueueAudio(samples: Float32Array): void {
    if (this.isFinalizing || this.isDone) {
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.fail("Connection lost during recording");
      return;
    }
    const transformed = this.transformAudio(samples);
    this.pendingChunks.push(transformed);
    this.pendingSampleCount += transformed.length;
    this.flushPending(false);
  }

  /** Hook for providers that need resampling before chunking. */
  protected transformAudio(samples: Float32Array): Float32Array {
    return samples;
  }

  protected getStreamSampleRate(): number {
    return this.sampleRate;
  }

  private getChunkSampleCounts(): { min: number; max: number } | null {
    if (!this.chunking) {
      return null;
    }
    const rate = this.getStreamSampleRate();
    const min = Math.max(
      1,
      Math.ceil((rate * this.chunking.minDurationMs) / 1000),
    );
    const max = Math.max(
      min,
      Math.ceil((rate * this.chunking.maxDurationMs) / 1000),
    );
    return { min, max };
  }

  private flushPending(isFinal: boolean): void {
    const counts = this.getChunkSampleCounts();
    while (this.pendingSampleCount > 0) {
      let chunk: Float32Array;
      if (!counts) {
        chunk = this.drainSamples(this.pendingSampleCount);
      } else if (this.pendingSampleCount >= counts.min) {
        chunk = this.drainSamples(
          Math.min(this.pendingSampleCount, counts.max),
        );
      } else if (isFinal) {
        const padded = new Float32Array(counts.min);
        padded.set(this.drainSamples(this.pendingSampleCount));
        chunk = padded;
      } else {
        return;
      }
      this.sendAudio(chunk, isFinal && this.pendingSampleCount === 0);
    }
  }

  private sendAudio(chunk: Float32Array, isFinal: boolean): void {
    const ws = this.ws;
    if (!ws) {
      return;
    }
    if (ws.bufferedAmount < this.lastBufferedAmount) {
      this.hasObservedDrain = true;
    }
    this.send(this.encodeAudio(chunk, isFinal));
    this.lastBufferedAmount = ws.bufferedAmount;
    this.sentChunkCount++;
  }

  private drainSamples(targetCount: number): Float32Array {
    const output = new Float32Array(targetCount);
    let filled = 0;
    while (filled < targetCount && this.pendingChunks.length > 0) {
      const current = this.pendingChunks[0];
      const remaining = targetCount - filled;
      if (current.length <= remaining) {
        output.set(current, filled);
        filled += current.length;
        this.pendingChunks.shift();
      } else {
        output.set(current.subarray(0, remaining), filled);
        this.pendingChunks[0] = current.subarray(remaining);
        filled += remaining;
      }
    }
    this.pendingSampleCount -= filled;
    return filled === targetCount ? output : output.subarray(0, filled);
  }

  private startFinalizeTimer(
    options?: TranscriptionSessionFinalizeOptions,
  ): void {
    if (this.isDone) {
      return;
    }
    const timeoutMs = this.getFinalizeTimeoutMs(options);
    this.finalizeTimer = setTimeout(
      () => this.onFinalizeTimeout(timeoutMs),
      timeoutMs,
    );
  }

  private settle(result: TranscriptionSessionResult): void {
    this.isDone = true;
    this.result = result;
    if (this.finalizeTimer) {
      clearTimeout(this.finalizeTimer);
      this.finalizeTimer = null;
    }
    this.lifetime.abort();
    this.relay?.stop();
    closeSocket(this.ws);
    this.pendingChunks = [];
    this.pendingSampleCount = 0;
    this.resolveReady?.();
    const resolveFinalize = this.resolveFinalize;
    this.resolveFinalize = null;
    resolveFinalize?.(result);
    if (!result.failureReason) {
      getLogger().info(
        `[${this.name}] stream complete (sent=${this.sentChunkCount} chunks)`,
      );
    }
  }

  private settledResult(): TranscriptionSessionResult {
    return (
      this.result ?? {
        rawTranscript: null,
        metadata: this.metadata,
        warnings: [],
        failureReason: this.failureReason ?? "Stream closed",
      }
    );
  }
}
