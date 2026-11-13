import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
import {
  emitAudioChunk,
  FakeWebSocket,
  flushMicrotasks,
  getAudioChunkListenerCount,
  recordedSamples,
  resetAudioChunkListeners,
} from "./streaming-session.fakes";

vi.mock(
  "@tauri-apps/api/event",
  async () => (await import("./streaming-session.fakes")).tauriEventMock,
);
vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);

const SAMPLE_RATE = 16_000;
const AUDIO = { samples: recordedSamples(1_600), sampleRate: SAMPLE_RATE };

const results = (transcript: string, extra: Record<string, unknown> = {}) => ({
  type: "Results",
  is_final: true,
  channel: { alternatives: [{ transcript }] },
  ...extra,
});

const startSession = async () => {
  const session = new DeepgramTranscriptionSession("dg-key");
  const started = session.onRecordingStart(SAMPLE_RATE);
  await flushMicrotasks();
  return { session, started, socket: FakeWebSocket.latest };
};

const startOpenSession = async () => {
  const context = await startSession();
  context.socket.open();
  await context.started;
  return context;
};

describe("DeepgramTranscriptionSession", () => {
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

  it("streams audio recorded before the socket opened and returns the transcript once Deepgram closes", async () => {
    const { session, started, socket } = await startSession();
    emitAudioChunk(AUDIO.samples);
    expect(socket.sentAudio).toHaveLength(0);
    socket.open();
    await started;
    expect(socket.sentAudio.length).toBeGreaterThan(0);

    socket.receive(results("hello world"));
    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    expect(socket.sentMessages.at(-1)).toEqual({ type: "CloseStream" });
    socket.disconnect(1000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: "hello world",
    });
    expect((await result).failureReason).toBeUndefined();
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when the socket cannot be opened", async () => {
    const { session, started, socket } = await startSession();
    socket.fail();
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "WebSocket connection failed",
    });
  });

  it("reports a failure when the connection does not open in time", async () => {
    const { session, started } = await startSession();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Deepgram not ready within 10s",
    });
  });

  it("waits for a connection still opening at stop instead of reporting it missing", async () => {
    const { session, socket } = await startSession();
    emitAudioChunk(AUDIO.samples);

    const result = session.finalize(AUDIO);
    socket.open();
    await flushMicrotasks();
    expect(socket.sentMessages.at(-1)).toEqual({ type: "CloseStream" });
    socket.receive(results("short", { speech_final: true }));

    await expect(result).resolves.toMatchObject({ rawTranscript: "short" });
  });

  it("reports a failure when the socket drops mid-recording instead of returning partial text", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive(results("hello"));
    socket.disconnect(1006);

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "Connection closed abnormally (code=1006)",
    });
  });

  it("reports a failure on a Deepgram error message", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ type: "Error", description: "rate limited" });

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Deepgram error: rate limited",
    });
  });

  it("reports a failure when Deepgram does not finish after CloseStream", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive(results("hello"));

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(3_000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "Deepgram did not finish within 3s",
    });
  });

  it("reports a failure when the stream closes abnormally during finalize", async () => {
    const { session, socket } = await startOpenSession();

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.disconnect(1011, "internal");

    await expect(result).resolves.toMatchObject({
      failureReason:
        "Connection closed abnormally (code=1011, reason=internal)",
    });
  });

  it("abandons the stream once more than 30s of audio piles up before it is ready", async () => {
    const { session, socket } = await startSession();
    for (let i = 0; i < 31; i++) {
      emitAudioChunk(recordedSamples(SAMPLE_RATE));
    }

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "Deepgram not ready after 30s of audio",
    });
    expect(socket.closedByClient).toBe(true);
    expect(getAudioChunkListenerCount()).toBe(0);
  });
});
