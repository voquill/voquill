import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
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

const endOfTurn = (transcript: string) => ({
  type: "Turn",
  end_of_turn: true,
  turn_order: 0,
  transcript,
});

const startSession = async () => {
  const session = new AssemblyAITranscriptionSession("aai-key");
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

describe("AssemblyAITranscriptionSession", () => {
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

  it("streams audio recorded before the socket opened and returns the transcript on Termination", async () => {
    const { session, started, socket } = await startSession();
    emitAudioChunk(AUDIO.samples);
    expect(socket.sentAudio).toHaveLength(0);
    socket.open();
    await started;
    expect(socket.sentAudio.length).toBeGreaterThan(0);

    socket.receive(endOfTurn("Hello world."));
    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    expect(socket.sentMessages.at(-1)).toEqual({ type: "Terminate" });
    socket.receive({ type: "Termination" });

    await expect(result).resolves.toMatchObject({
      rawTranscript: "Hello world.",
    });
    expect((await result).failureReason).toBeUndefined();
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("waits for a socket still opening at stop and finishes the stream", async () => {
    const { session, socket } = await startSession();
    emitAudioChunk(AUDIO.samples);

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    expect(socket.sent).toHaveLength(0);
    socket.open();
    await flushMicrotasks();
    expect(socket.sentAudio.length).toBeGreaterThan(0);
    socket.receive(endOfTurn("Quick."));
    socket.receive({ type: "Termination" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "Quick." });
  });

  it("closes a socket that opens only after the session was cleaned up", async () => {
    const onInterim = vi.fn();
    const session = new AssemblyAITranscriptionSession("aai-key");
    session.setInterimResultCallback(onInterim);
    const started = session.onRecordingStart(SAMPLE_RATE);
    await flushMicrotasks();
    const socket = FakeWebSocket.latest;
    emitAudioChunk(AUDIO.samples);

    session.cleanup();
    await started;
    socket.open();
    socket.receive(endOfTurn("stale"));

    expect(socket.closedByClient).toBe(true);
    expect(socket.sent).toHaveLength(0);
    expect(onInterim).not.toHaveBeenCalled();
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when the socket cannot be opened", async () => {
    const { session, started, socket } = await startSession();
    socket.fail();
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "WebSocket connection failed",
    });
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when AssemblyAI closes the stream mid-recording", async () => {
    const { session, socket } = await startOpenSession();
    socket.disconnect(3005, "Session expired");

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason:
        "Connection closed during recording (code=3005, reason=Session expired)",
    });
  });

  it("reports a failure on an error message", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ error: "Invalid audio" });

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "AssemblyAI error: Invalid audio",
    });
  });

  it("reports a failure when the stream is not terminated in time", async () => {
    const { session } = await startOpenSession();

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({
      failureReason: "AssemblyAI did not finish within 2s",
    });
  });
});
