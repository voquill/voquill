import type { TranscribeAudioResult } from "../actions/transcribe.actions";

type AudioChunkHandler = (event: { payload: { samples: number[] } }) => void;

const audioChunkHandlers = new Set<AudioChunkHandler>();

/** Stand-in for `@tauri-apps/api/event`, driven by `emitAudioChunk`. */
export const tauriEventMock = {
  listen: async (_event: string, handler: AudioChunkHandler) => {
    audioChunkHandlers.add(handler);
    return () => {
      audioChunkHandlers.delete(handler);
    };
  },
};

export const emitAudioChunk = (samples: number[]): void => {
  for (const handler of Array.from(audioChunkHandlers)) {
    handler({ payload: { samples } });
  }
};

export const recordedSamples = (count: number): number[] =>
  Array.from({ length: count }, () => 0.1);

export const getAudioChunkListenerCount = (): number => audioChunkHandlers.size;

export const resetAudioChunkListeners = (): void => {
  audioChunkHandlers.clear();
};

type Handler = ((event: never) => void) | null;

/** Minimal scriptable WebSocket for driving streaming sessions in tests. */
export class FakeWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  static instances: FakeWebSocket[] = [];

  readyState = FakeWebSocket.CONNECTING;
  bufferedAmount = 0;
  binaryType = "blob";
  sent: unknown[] = [];
  closedByClient = false;
  onopen: Handler = null;
  onmessage: Handler = null;
  onerror: Handler = null;
  onclose: Handler = null;

  constructor(
    public readonly url: string,
    public readonly protocols?: string | string[],
  ) {
    FakeWebSocket.instances.push(this);
  }

  static get latest(): FakeWebSocket {
    const socket = FakeWebSocket.instances.at(-1);
    if (!socket) {
      throw new Error("No WebSocket was created");
    }
    return socket;
  }

  static reset(): void {
    FakeWebSocket.instances = [];
  }

  send(data: unknown): void {
    if (this.readyState !== FakeWebSocket.OPEN) {
      throw new Error("WebSocket is not open");
    }
    this.sent.push(data);
  }

  close(): void {
    this.closedByClient = true;
    this.disconnect(1000);
  }

  get sentMessages(): Record<string, unknown>[] {
    return this.sent
      .filter((data): data is string => typeof data === "string")
      .map((data) => JSON.parse(data));
  }

  get sentAudio(): unknown[] {
    return this.sent.filter((data) => typeof data !== "string");
  }

  open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.fire("onopen", {});
  }

  receive(message: Record<string, unknown>): void {
    this.fire("onmessage", { data: JSON.stringify(message) });
  }

  fail(): void {
    this.fire("onerror", {});
    this.disconnect(1006);
  }

  disconnect(code: number, reason = ""): void {
    if (this.readyState === FakeWebSocket.CLOSED) {
      return;
    }
    this.readyState = FakeWebSocket.CLOSED;
    this.fire("onclose", { code, reason });
  }

  private fire(
    handler: "onopen" | "onmessage" | "onerror" | "onclose",
    event: unknown,
  ): void {
    (this[handler] as ((event: unknown) => void) | null)?.(event);
  }
}

export const transcribeResult = (
  rawTranscript: string,
): TranscribeAudioResult => ({
  rawTranscript,
  warnings: [],
  metadata: { transcriptionMode: "cloud", inferenceDevice: "Batch" },
});

/** Resolves pending promise callbacks without advancing fake timers. */
export const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
};

const noop = () => {};

/** Stand-in for `../utils/log.utils`, which otherwise needs the Tauri runtime. */
export const logUtilsMock = {
  getLogger: () => ({
    info: noop,
    warning: noop,
    error: noop,
    verbose: noop,
    stopwatch: <T>(_label: string, fn: () => Promise<T>) => fn(),
  }),
};
