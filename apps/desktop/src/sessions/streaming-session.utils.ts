import { listen, UnlistenFn } from "@tauri-apps/api/event";

export const STREAM_CONNECT_TIMEOUT_MS = 10_000;
// More unsent audio than this at finalize means the socket stalled (e.g. after
// sleep/wake) and the provider cannot have heard the whole recording.
export const MAX_UNSENT_AUDIO_SECONDS = 2;

export type StreamingFinalizeOutcome =
  | { text: string }
  | { failureReason: string };

type AudioChunkPayload = {
  samples: number[] | Float32Array;
};

type AudioChunkSink = (samples: Float32Array) => void;

/**
 * Subscribes to recorder audio chunks as soon as recording starts and buffers
 * them until the provider connection is ready, so no audio recorded during the
 * handshake is missing from the stream.
 */
export class AudioChunkRelay {
  private buffered: Float32Array[] = [];
  private sink: AudioChunkSink | null = null;
  private stopped = false;
  private unlisten: UnlistenFn | null = null;

  static async start(): Promise<AudioChunkRelay> {
    const relay = new AudioChunkRelay();
    relay.unlisten = await listen<AudioChunkPayload>("audio_chunk", (event) =>
      relay.push(
        event.payload.samples instanceof Float32Array
          ? event.payload.samples
          : Float32Array.from(event.payload.samples),
      ),
    );
    return relay;
  }

  pipeTo(sink: AudioChunkSink): void {
    if (this.stopped) {
      return;
    }
    this.sink = sink;
    const buffered = this.buffered;
    this.buffered = [];
    for (const samples of buffered) {
      sink(samples);
    }
  }

  stop(): void {
    this.stopped = true;
    this.sink = null;
    this.buffered = [];
    this.unlisten?.();
    this.unlisten = null;
  }

  private push(samples: Float32Array): void {
    if (this.stopped || samples.length === 0) {
      return;
    }
    if (this.sink) {
      this.sink(samples);
    } else {
      this.buffered.push(samples);
    }
  }
}

export const getStalledUploadFailure = (
  ws: WebSocket,
  audioBytesPerSecond: number,
): string | null => {
  const unsentSeconds = ws.bufferedAmount / audioBytesPerSecond;
  if (unsentSeconds <= MAX_UNSENT_AUDIO_SECONDS) {
    return null;
  }
  return `Connection stalled with ${unsentSeconds.toFixed(1)}s of audio unsent`;
};

/** Closes a socket we are done with without firing its handlers again. */
export const closeSocket = (ws: WebSocket | null): void => {
  if (!ws) {
    return;
  }
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  if (ws.readyState !== WebSocket.CLOSED) {
    ws.close();
  }
};

// 1006: dropped without a close frame; 1011: provider-side error.
export const getAbnormalCloseFailure = (event: CloseEvent): string | null =>
  event.code === 1006 || event.code === 1011
    ? `Connection closed abnormally (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`
    : null;

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const withTimeout = <T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> =>
  new Promise<T>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(new Error(`Timed out after ${Math.round(timeoutMs / 1000)}s`)),
      timeoutMs,
    );
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
