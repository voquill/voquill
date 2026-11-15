import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  getNewServerTranscriptDelta,
  NewServerTranscriptionSession,
} from "./new-server-transcription-session";
import { RecoverableTranscriptionSession } from "./recoverable-transcription-session";
import {
  emitAudioChunk,
  FakeWebSocket,
  flushMicrotasks,
  getAudioChunkListenerCount,
  recordedSamples,
  resetAudioChunkListeners,
  transcribeResult,
} from "./streaming-session.fakes";

const idToken = vi.hoisted(() => vi.fn());

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
  getNewServerIdToken: idToken,
}));

const SAMPLE_RATE = 16_000;
const AUDIO = { samples: recordedSamples(8_000), sampleRate: SAMPLE_RATE };

const startSession = async () => {
  const session = new NewServerTranscriptionSession();
  const started = session.onRecordingStart(SAMPLE_RATE);
  await flushMicrotasks();
  return { session, started, socket: FakeWebSocket.latest };
};

/** Drives the socket through auth -> config -> ready. */
const handshake = async (socket: FakeWebSocket) => {
  socket.open();
  await flushMicrotasks();
  socket.receive({ type: "authenticated", uid: "u", wordsRemaining: 100 });
  socket.receive({ type: "ready" });
};

const startReadySession = async () => {
  const context = await startSession();
  await handshake(context.socket);
  await context.started;
  return context;
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

describe("NewServerTranscriptionSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.reset();
    resetAudioChunkListeners();
    idToken.mockReset();
    idToken.mockResolvedValue("id-token");
    setAppState({ ...INITIAL_APP_STATE });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("streams buffered and live audio, emits live segments and returns the server transcript", async () => {
    const onInterim = vi.fn();
    const session = new NewServerTranscriptionSession();
    session.setInterimResultCallback(onInterim);
    const started = session.onRecordingStart(SAMPLE_RATE);
    await flushMicrotasks();

    emitAudioChunk([0.1, 0.2]);
    const socket = FakeWebSocket.latest;
    await handshake(socket);
    await started;

    expect(socket.sentMessages.slice(0, 2)).toEqual([
      { type: "auth", idToken: "id-token" },
      expect.objectContaining({ type: "config", sampleRate: SAMPLE_RATE }),
    ]);
    expect(socket.sentAudio).toHaveLength(1);
    emitAudioChunk([0.3]);
    expect(socket.sentAudio).toHaveLength(2);

    socket.receive({
      type: "partial_transcript",
      text: "hello",
      is_final: true,
    });
    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    expect(socket.sentMessages.at(-1)).toEqual({ type: "finalize" });
    socket.receive({
      type: "partial_transcript",
      text: "hello world",
      is_final: true,
    });
    socket.receive({
      type: "transcript",
      text: "hello world",
      source: "deepgram",
      durationMs: 300,
      processed: { text: "Hello world.", durationMs: 200 },
    });

    await expect(result).resolves.toMatchObject({
      rawTranscript: "hello world",
      processedTranscript: "Hello world.",
      metadata: { inferenceDevice: "Cloud • deepgram" },
    });
    expect((await result).failureReason).toBeUndefined();
    expect(onInterim.mock.calls).toEqual([["hello"], ["world"]]);
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("fails when the socket cannot be opened", async () => {
    const { session, started, socket } = await startSession();
    socket.fail();
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "WebSocket connection failed",
    });
  });

  it("fails when the auth token cannot be fetched", async () => {
    idToken.mockRejectedValue(new Error("token refresh failed"));
    const { session, started, socket } = await startSession();
    socket.open();
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Authentication failed: token refresh failed",
    });
  });

  it("fails when the server rejects the handshake", async () => {
    const { session, started, socket } = await startSession();
    socket.open();
    await flushMicrotasks();
    socket.receive({ type: "error", code: "QUOTA_EXCEEDED", message: "none" });
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Server error QUOTA_EXCEEDED: none",
    });
    expect(socket.closedByClient).toBe(true);
  });

  it("fails when the handshake does not complete in time", async () => {
    const { session, started, socket } = await startSession();
    socket.open();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "NewServer not ready within 10s",
    });
  });

  it("waits for a handshake still in progress at stop, then flushes the audio before finalizing", async () => {
    const { session, socket } = await startSession();
    emitAudioChunk([0.1]);

    const result = session.finalize(AUDIO);
    await handshake(socket);
    await flushMicrotasks();

    expect(socket.sent.at(-2)).toBeInstanceOf(Float32Array);
    expect(socket.sentMessages.at(-1)).toEqual({ type: "finalize" });
    socket.receive({ type: "transcript", text: "quick note", source: "x" });
    await expect(result).resolves.toMatchObject({
      rawTranscript: "quick note",
    });
  });

  it("does not stream or emit after being cleaned up before the handshake finished", async () => {
    const onInterim = vi.fn();
    const session = new NewServerTranscriptionSession();
    session.setInterimResultCallback(onInterim);
    const started = session.onRecordingStart(SAMPLE_RATE);
    await flushMicrotasks();
    const socket = FakeWebSocket.latest;

    session.cleanup();
    await started;
    socket.open();
    socket.receive({ type: "ready" });
    socket.receive({
      type: "partial_transcript",
      text: "late",
      is_final: true,
    });
    emitAudioChunk([0.1]);

    expect(socket.closedByClient).toBe(true);
    expect(socket.sent).toEqual([]);
    expect(onInterim).not.toHaveBeenCalled();
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("fails immediately at stop when the socket dropped mid-recording", async () => {
    const { session, socket } = await startReadySession();
    socket.disconnect(1006);
    emitAudioChunk([0.4]);

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Connection closed abnormally (code=1006)",
    });
    expect(socket.sentMessages.some((m) => m.type === "finalize")).toBe(false);
  });

  it("fails when audio arrives after the socket closed silently", async () => {
    const { session, socket } = await startReadySession();
    socket.readyState = FakeWebSocket.CLOSED;
    emitAudioChunk([0.4]);

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Connection lost during recording",
    });
  });

  it("fails when a server error arrives mid-recording", async () => {
    const { session, socket } = await startReadySession();
    socket.receive({ type: "error", code: "SESSION_ERROR", message: "idle" });

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Server error SESSION_ERROR: idle",
    });
  });

  it("waits for a slow but draining upload instead of failing it", async () => {
    const { session, socket } = await startReadySession();
    socket.bufferedAmount = 0;
    emitAudioChunk(recordedSamples(1_600));
    socket.bufferedAmount = 600_000;
    emitAudioChunk(recordedSamples(1_600));
    socket.bufferedAmount = 500_000;
    emitAudioChunk(recordedSamples(1_600));

    const result = session.finalize(AUDIO);
    for (let remaining = 400_000; remaining > 0; remaining -= 100_000) {
      await vi.advanceTimersByTimeAsync(3_500);
      socket.bufferedAmount = remaining;
    }
    await vi.advanceTimersByTimeAsync(3_500);
    socket.bufferedAmount = 0;
    await vi.advanceTimersByTimeAsync(250);
    await vi.advanceTimersByTimeAsync(14_000);
    socket.receive({ type: "transcript", text: "slow link", source: "x" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "slow link" });
  });

  it("fails when an upload known to drain stops making progress", async () => {
    const { session, socket } = await startReadySession();
    socket.bufferedAmount = 300_000;
    emitAudioChunk(recordedSamples(1_600));
    socket.bufferedAmount = 200_000;
    emitAudioChunk(recordedSamples(1_600));

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(10_250);

    await expect(result).resolves.toMatchObject({
      failureReason:
        "Upload stalled: 200000 bytes unsent with no progress for 10s",
    });
  });

  it("never fails a stream whose bufferedAmount is stuck when the server still answers", async () => {
    const { session, socket } = await startReadySession();
    socket.bufferedAmount = 400_000;
    emitAudioChunk(recordedSamples(1_600));
    emitAudioChunk(recordedSamples(1_600));

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(12_000);
    socket.receive({ type: "transcript", text: "fine", source: "x" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "fine" });
  });

  it("fails when the socket drops during finalize", async () => {
    const { session, socket } = await startReadySession();
    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.disconnect(1006);

    await expect(result).resolves.toMatchObject({
      failureReason: "Connection closed abnormally (code=1006)",
    });
  });

  it("fails when the server errors during finalize", async () => {
    const { session, socket } = await startReadySession();
    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.receive({
      type: "error",
      code: "TRANSCRIPTION_FAILED",
      message: "x",
    });

    await expect(result).resolves.toMatchObject({
      failureReason: "Server error TRANSCRIPTION_FAILED: x",
    });
  });

  it("fails when no transcript arrives within 15s of finalize", async () => {
    const { session } = await startReadySession();
    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(15_000);

    await expect(result).resolves.toMatchObject({
      failureReason: "Server did not return a transcript within 15s",
    });
  });

  it("returns the same result when finalize is called twice and sends finalize once", async () => {
    const { session, socket } = await startReadySession();

    const first = session.finalize(AUDIO);
    const second = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.receive({ type: "transcript", text: "once", source: "x" });

    expect(first).toBe(second);
    await expect(first).resolves.toMatchObject({ rawTranscript: "once" });
    expect(
      socket.sentMessages.filter((m) => m.type === "finalize"),
    ).toHaveLength(1);
  });

  it("fails the session instead of throwing into the audio listener when send throws", async () => {
    const { session, socket } = await startReadySession();
    socket.send = () => {
      throw new Error("socket write failed");
    };

    expect(() => emitAudioChunk([0.1])).not.toThrow();
    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Failed to send audio: socket write failed",
    });
  });

  it.each([
    ["QUOTA_EXCEEDED", "quota_exceeded"],
    ["AUTH_FAILED", "auth_failed"],
  ])(
    "reports %s as a non-retryable failure",
    async (serverCode, failureCode) => {
      const { session, started, socket } = await startSession();
      socket.open();
      await flushMicrotasks();
      socket.receive({ type: "error", code: serverCode, message: "no" });
      await started;

      await expect(session.finalize(AUDIO)).resolves.toMatchObject({
        failureReason: `Server error ${serverCode}: no`,
        failureCode,
      });
    },
  );

  it("reports being signed out as an auth failure", async () => {
    const { NotAuthenticatedError } = await import("../utils/new-server.utils");
    idToken.mockRejectedValue(new NotAuthenticatedError());
    const { session, started, socket } = await startSession();
    socket.open();
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureCode: "auth_failed",
    });
  });

  it("settles exactly once and ignores a transcript that arrives after a failure", async () => {
    const { session, socket } = await startReadySession();
    const onmessage = socket.onmessage;

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(15_000);
    (onmessage as (event: unknown) => void)({
      data: JSON.stringify({ type: "transcript", text: "late" }),
    });

    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "Server did not return a transcript within 15s",
    });
  });
});

describe("NewServerTranscriptionSession with recovery", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    FakeWebSocket.reset();
    resetAudioChunkListeners();
    idToken.mockReset();
    idToken.mockResolvedValue("id-token");
    setAppState({ ...INITIAL_APP_STATE });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const startRecoverable = async (
    transcribe = vi.fn(async () => transcribeResult("recovered from audio")),
  ) => {
    const session = new RecoverableTranscriptionSession(
      new NewServerTranscriptionSession(),
      { transcribe },
    );
    const started = session.onRecordingStart(SAMPLE_RATE);
    await flushMicrotasks();
    return { session, started, transcribe, socket: FakeWebSocket.latest };
  };

  it("uses the streamed transcript on the happy path without re-transcribing", async () => {
    const { session, started, transcribe, socket } = await startRecoverable();
    await handshake(socket);
    await started;

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.receive({ type: "transcript", text: "streamed", source: "x" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "streamed" });
    expect(transcribe).not.toHaveBeenCalled();
  });

  it("recovers the full recording when the socket drops mid-recording", async () => {
    const { session, started, transcribe, socket } = await startRecoverable();
    await handshake(socket);
    await started;
    socket.disconnect(1006);

    const result = await session.finalize(AUDIO);

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith(
      expect.objectContaining({
        samples: AUDIO.samples,
        sampleRate: SAMPLE_RATE,
      }),
    );
    expect(result).toMatchObject({
      rawTranscript: "recovered from audio",
      recovered: true,
    });
  });

  it("keeps recording and recovers when the socket never opens", async () => {
    const { session, started, transcribe, socket } = await startRecoverable();
    socket.fail();
    await expect(started).resolves.toBeUndefined();

    const result = await session.finalize(AUDIO);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.rawTranscript).toBe("recovered from audio");
  });

  it("recovers and closes the socket when the finalize prompt cannot be built", async () => {
    setAppState({ ...INITIAL_APP_STATE, activeRecordingMode: "dictate" });
    const { session, started, transcribe, socket } = await startRecoverable();
    await handshake(socket);
    await started;

    const result = await session.finalize(AUDIO);
    expect(result.rawTranscript).toBe("recovered from audio");
    expect(result.warnings[0]).toContain("Default tone not found");
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(socket.closedByClient).toBe(true);
  });

  it("does not burn recovery attempts on an exhausted word quota", async () => {
    const { session, started, transcribe, socket } = await startRecoverable();
    socket.open();
    await flushMicrotasks();
    socket.receive({ type: "error", code: "QUOTA_EXCEEDED", message: "none" });
    await started;

    const result = await session.finalize(AUDIO);

    expect(transcribe).not.toHaveBeenCalled();
    expect(result).toMatchObject({
      rawTranscript: null,
      failureCode: "quota_exceeded",
    });
  });

  it("reports failure without discarding when recovery also fails", async () => {
    const transcribe = vi.fn(async () => {
      throw new Error("Network unreachable");
    });
    const { session, started, socket } = await startRecoverable(transcribe);
    socket.fail();
    await started;

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(60_000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "Network unreachable",
    });
  });
});
