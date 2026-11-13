import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  getNewServerTranscriptDelta,
  NewServerDictationStream,
  NewServerTranscriptionSession,
} from "./new-server-transcription-session";
import { RecoverableTranscriptionSession } from "./recoverable-transcription-session";
import {
  emitAudioChunk,
  FakeWebSocket,
  flushMicrotasks,
  getAudioChunkListenerCount,
  resetAudioChunkListeners,
  transcribeResult,
  recordedSamples,
} from "./streaming-session.fakes";

vi.mock(
  "@tauri-apps/api/event",
  async () => (await import("./streaming-session.fakes")).tauriEventMock,
);
vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);
vi.mock(import("../utils/new-server.utils"), async (importOriginal) => ({
  ...(await importOriginal()),
  getNewServerIdToken: async () => "id-token",
}));

const SAMPLE_RATE = 16_000;

const makeStream = (
  overrides: Partial<
    ConstructorParameters<typeof NewServerDictationStream>[0]
  > = {},
) =>
  new NewServerDictationStream({
    url: "wss://test/v1/dictation",
    sampleRate: SAMPLE_RATE,
    glossary: ["Voquill"],
    language: "en",
    getIdToken: async () => "id-token",
    ...overrides,
  });

/** Drives the socket through auth -> config -> ready. */
const handshake = async (socket: FakeWebSocket) => {
  socket.open();
  await flushMicrotasks();
  socket.receive({ type: "authenticated", uid: "u", wordsRemaining: 100 });
  socket.receive({ type: "ready" });
};

const startStream = async (stream: NewServerDictationStream) => {
  const started = stream.start();
  await flushMicrotasks();
  const socket = FakeWebSocket.latest;
  await handshake(socket);
  await started;
  return socket;
};

describe("getNewServerTranscriptDelta", () => {
  it("returns only the newly committed text for cumulative transcripts", () => {
    expect(
      getNewServerTranscriptDelta("hello world", "hello world again"),
    ).toBe("again");
  });

  it("returns the full transcript when the server transcript does not extend the previous one", () => {
    expect(getNewServerTranscriptDelta("hello world", "fresh start")).toBe(
      "fresh start",
    );
  });
});

describe("NewServerDictationStream", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.reset();
    resetAudioChunkListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("streams buffered and live audio, then returns the server transcript", async () => {
    const onInterimSegment = vi.fn();
    const stream = makeStream({ onInterimSegment });
    const started = stream.start();
    await flushMicrotasks();

    emitAudioChunk([0.1, 0.2]);
    const socket = FakeWebSocket.latest;
    await handshake(socket);
    await started;

    expect(socket.sentMessages.slice(0, 2)).toEqual([
      { type: "auth", idToken: "id-token" },
      {
        type: "config",
        sampleRate: SAMPLE_RATE,
        glossary: ["Voquill"],
        language: "en",
      },
    ]);
    expect(socket.sentAudio).toHaveLength(1);

    emitAudioChunk([0.3]);
    expect(socket.sentAudio).toHaveLength(2);

    socket.receive({
      type: "partial_transcript",
      text: "hello",
      is_final: true,
    });
    socket.receive({
      type: "partial_transcript",
      text: "hello world",
      is_final: true,
    });
    expect(onInterimSegment.mock.calls).toEqual([["hello"], ["world"]]);

    const outcome = stream.finalize({ prompt: "clean {{transcript}}" });
    await flushMicrotasks();
    expect(socket.sentMessages.at(-1)).toEqual({
      type: "finalize",
      prompt: "clean {{transcript}}",
    });
    socket.receive({
      type: "transcript",
      text: "hello world",
      source: "deepgram",
      durationMs: 300,
      processed: { text: "Hello world.", durationMs: 200 },
    });

    await expect(outcome).resolves.toEqual({
      transcript: {
        text: "hello world",
        source: "deepgram",
        durationMs: 300,
        processed: { text: "Hello world.", durationMs: 200 },
      },
    });
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("fails when the socket cannot be opened", async () => {
    const stream = makeStream();
    const started = stream.start();
    await flushMicrotasks();
    FakeWebSocket.latest.fail();

    await expect(started).rejects.toThrow("WebSocket error");
    await expect(stream.finalize()).resolves.toEqual({
      failureReason: "WebSocket error",
    });
  });

  it("fails when the auth token cannot be fetched", async () => {
    const stream = makeStream({
      getIdToken: async () => {
        throw new Error("token refresh failed");
      },
    });
    const started = stream.start();
    await flushMicrotasks();
    FakeWebSocket.latest.open();

    await expect(started).rejects.toThrow(
      "Authentication failed: token refresh failed",
    );
  });

  it("fails when the server rejects the handshake", async () => {
    const stream = makeStream();
    const started = stream.start();
    await flushMicrotasks();
    const socket = FakeWebSocket.latest;
    socket.open();
    await flushMicrotasks();
    socket.receive({
      type: "error",
      code: "QUOTA_EXCEEDED",
      message: "No words left",
    });

    await expect(started).rejects.toThrow(
      "Server error QUOTA_EXCEEDED: No words left",
    );
    expect(socket.closedByClient).toBe(true);
  });

  it("fails when the handshake does not complete in time", async () => {
    const stream = makeStream();
    const started = stream.start();
    const rejection = expect(started).rejects.toThrow(
      "Server not ready within 10s",
    );
    await flushMicrotasks();
    FakeWebSocket.latest.open();

    await vi.advanceTimersByTimeAsync(10_000);
    await rejection;
  });

  it("waits for a handshake still in progress at finalize, then flushes audio first", async () => {
    const stream = makeStream();
    void stream.start();
    await flushMicrotasks();
    emitAudioChunk([0.1]);

    const outcome = stream.finalize();
    const socket = FakeWebSocket.latest;
    await handshake(socket);
    await flushMicrotasks();

    expect(socket.sent.at(-2)).toBeInstanceOf(Float32Array);
    expect(socket.sentMessages.at(-1)).toEqual({ type: "finalize" });
    socket.receive({
      type: "transcript",
      text: "quick note",
      source: "deepgram",
    });
    await expect(outcome).resolves.toMatchObject({
      transcript: { text: "quick note" },
    });
  });

  it("fails immediately at finalize when the socket dropped mid-recording", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);

    socket.disconnect(1006);
    emitAudioChunk([0.4]);

    await expect(stream.finalize()).resolves.toEqual({
      failureReason: "Connection closed (code=1006)",
    });
    expect(socket.sentMessages.some((m) => m.type === "finalize")).toBe(false);
  });

  it("fails when audio arrives after the socket closed silently", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);

    socket.readyState = FakeWebSocket.CLOSED;
    emitAudioChunk([0.4]);

    await expect(stream.finalize()).resolves.toEqual({
      failureReason: "Connection lost during recording",
    });
  });

  it("fails when a server error arrives mid-recording", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);

    socket.receive({
      type: "error",
      code: "SESSION_ERROR",
      message: "timed out",
    });

    await expect(stream.finalize()).resolves.toEqual({
      failureReason: "Server error SESSION_ERROR: timed out",
    });
  });

  it("fails without sending finalize when the upload stalled", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);

    socket.bufferedAmount = SAMPLE_RATE * 4 * 3;

    await expect(stream.finalize()).resolves.toEqual({
      failureReason: "Connection stalled with 3.0s of audio unsent",
    });
    expect(socket.sentMessages.some((m) => m.type === "finalize")).toBe(false);
  });

  it("fails when the socket drops during finalize", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);

    const outcome = stream.finalize();
    await flushMicrotasks();
    socket.disconnect(1006);

    await expect(outcome).resolves.toEqual({
      failureReason: "Connection closed (code=1006)",
    });
  });

  it("fails when the server errors during finalize", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);

    const outcome = stream.finalize();
    await flushMicrotasks();
    socket.receive({
      type: "error",
      code: "TRANSCRIPTION_FAILED",
      message: "both failed",
    });

    await expect(outcome).resolves.toEqual({
      failureReason: "Server error TRANSCRIPTION_FAILED: both failed",
    });
  });

  it.each([
    [undefined, 15_000],
    [{ prompt: "clean {{transcript}}" }, 30_000],
  ])(
    "fails when no transcript arrives after finalize (%o)",
    async (options, timeoutMs) => {
      const stream = makeStream();
      const socket = await startStream(stream);

      const outcome = stream.finalize(options);
      await vi.advanceTimersByTimeAsync(timeoutMs - 1);
      socket.receive({
        type: "partial_transcript",
        text: "x",
        is_final: false,
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(outcome).resolves.toEqual({
        failureReason: `Server did not return a transcript within ${timeoutMs / 1000}s`,
      });
    },
  );

  it("settles exactly once and ignores a transcript that arrives after a failure", async () => {
    const stream = makeStream();
    const socket = await startStream(stream);
    const onmessage = socket.onmessage;

    const outcome = stream.finalize();
    await vi.advanceTimersByTimeAsync(15_000);
    (onmessage as (event: unknown) => void)({
      data: JSON.stringify({ type: "transcript", text: "late" }),
    });

    await expect(outcome).resolves.toEqual({
      failureReason: "Server did not return a transcript within 15s",
    });
    await expect(stream.finalize()).resolves.toEqual({
      failureReason: "Server did not return a transcript within 15s",
    });
  });

  it("closes an in-flight connection when cleaned up", async () => {
    const stream = makeStream();
    const started = stream.start();
    await flushMicrotasks();
    const socket = FakeWebSocket.latest;

    stream.close();

    await expect(started).rejects.toThrow("Stream closed");
    expect(socket.closedByClient).toBe(true);
    expect(getAudioChunkListenerCount()).toBe(0);
  });
});

describe("NewServerTranscriptionSession with recovery", () => {
  const audio = {
    samples: recordedSamples(8_000),
    sampleRate: SAMPLE_RATE,
  };

  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.reset();
    resetAudioChunkListeners();
    setAppState({ ...INITIAL_APP_STATE });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const startSession = async (
    transcribe = vi.fn(async () => transcribeResult("recovered from audio")),
  ) => {
    const session = new RecoverableTranscriptionSession(
      new NewServerTranscriptionSession(),
      { transcribe },
    );
    const started = session.onRecordingStart(SAMPLE_RATE);
    await flushMicrotasks();
    return { session, started, transcribe };
  };

  it("uses the streamed transcript on the happy path without re-transcribing", async () => {
    const { session, started, transcribe } = await startSession();
    const socket = FakeWebSocket.latest;
    await handshake(socket);
    await started;

    const result = session.finalize(audio);
    await flushMicrotasks();
    socket.receive({
      type: "transcript",
      text: "streamed",
      source: "deepgram",
      processed: { text: "Streamed." },
    });

    await expect(result).resolves.toMatchObject({
      rawTranscript: "streamed",
      processedTranscript: "Streamed.",
    });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("recovers the full recording when the socket drops mid-recording", async () => {
    const { session, started, transcribe } = await startSession();
    const socket = FakeWebSocket.latest;
    await handshake(socket);
    await started;
    socket.disconnect(1006);

    const result = await session.finalize(audio);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith({
      samples: audio.samples,
      sampleRate: SAMPLE_RATE,
    });
    expect(result).toMatchObject({
      rawTranscript: "recovered from audio",
      recovered: true,
    });
    expect(result.processedTranscript).toBeUndefined();
  });

  it("keeps recording and recovers when the socket never opens", async () => {
    const { session, started, transcribe } = await startSession();
    FakeWebSocket.latest.fail();
    await expect(started).resolves.toBeUndefined();

    const result = await session.finalize(audio);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.rawTranscript).toBe("recovered from audio");
  });

  it("recovers when finalize times out", async () => {
    const { session, started, transcribe } = await startSession();
    await handshake(FakeWebSocket.latest);
    await started;

    const result = session.finalize(audio);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: "recovered from audio",
      recovered: true,
    });
    expect(transcribe).toHaveBeenCalledTimes(1);
  });

  it("recovers and closes the socket when the finalize prompt cannot be built", async () => {
    setAppState({ ...INITIAL_APP_STATE, activeRecordingMode: "dictate" });
    const { session, started, transcribe } = await startSession();
    const socket = FakeWebSocket.latest;
    await handshake(socket);
    await started;

    const result = await session.finalize(audio);

    expect(result.rawTranscript).toBe("recovered from audio");
    expect(result.warnings[0]).toContain("Default tone not found");
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(socket.closedByClient).toBe(true);
  });

  it("reports failure without discarding when recovery also fails", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("Network unreachable");
    });
    const { session, started } = await startSession(transcribe);
    FakeWebSocket.latest.fail();
    await started;

    const result = session.finalize(audio);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "Network unreachable",
    });
  });
});
