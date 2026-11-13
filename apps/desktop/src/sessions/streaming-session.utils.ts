import { listen, UnlistenFn } from "@tauri-apps/api/event";

/**
 * Audio buffered while a provider is not ready yet. Past this the stream is
 * abandoned and the dictation is recovered from the recorder's own copy, so
 * the relay never holds more than this much audio.
 */
export const RELAY_MAX_BUFFERED_SECONDS = 30;

type AudioChunkPayload = {
  samples: number[] | Float32Array;
};

type AudioChunkSink = (samples: Float32Array) => void;

export type AudioChunkRelayOptions = {
  maxBufferedSamples: number;
  onOverflow: () => void;
};

/**
 * Subscribes to recorder audio chunks as soon as recording starts and buffers
 * them (bounded) until the provider connection is ready, so audio recorded
 * during the handshake is not missing from the stream.
 */
export class AudioChunkRelay {
  private buffered: Float32Array[] = [];
  private bufferedSamples = 0;
  private sink: AudioChunkSink | null = null;
  private stopped = false;
  private unlisten: UnlistenFn | null = null;

  private constructor(private readonly options: AudioChunkRelayOptions) {}

  static async start(
    options: AudioChunkRelayOptions,
  ): Promise<AudioChunkRelay> {
    const relay = new AudioChunkRelay(options);
    const unlisten = await listen<AudioChunkPayload>("audio_chunk", (event) =>
      relay.push(
        event.payload.samples instanceof Float32Array
          ? event.payload.samples
          : Float32Array.from(event.payload.samples),
      ),
    );
    if (relay.stopped) {
      unlisten();
    } else {
      relay.unlisten = unlisten;
    }
    return relay;
  }

  pipeTo(sink: AudioChunkSink): void {
    if (this.stopped) {
      return;
    }
    this.sink = sink;
    const buffered = this.buffered;
    this.buffered = [];
    this.bufferedSamples = 0;
    for (const samples of buffered) {
      sink(samples);
    }
  }

  stop(): void {
    this.stopped = true;
    this.sink = null;
    this.buffered = [];
    this.bufferedSamples = 0;
    this.unlisten?.();
    this.unlisten = null;
  }

  private push(samples: Float32Array): void {
    if (this.stopped || samples.length === 0) {
      return;
    }
    if (this.sink) {
      this.sink(samples);
      return;
    }
    this.buffered.push(samples);
    this.bufferedSamples += samples.length;
    if (this.bufferedSamples > this.options.maxBufferedSamples) {
      this.stop();
      this.options.onOverflow();
    }
  }
}

export const toErrorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);
