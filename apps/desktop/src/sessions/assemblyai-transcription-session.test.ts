import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
import {
  emitAudioChunk,
  FakeWebSocket,
  flushMicrotasks,
  getAudioChunkListenerCount,
  resetAudioChunkListeners,
  recordedSamples,
} from "./streaming-session.fakes";

vi.mock(
  "@tauri-apps/api/event",
  async () => (await import("./streaming-session.fakes")).tauriEventMock,
);

const SAMPLE_RATE = 16_000;
const AUDIO = { samples: recordedSamples(1_600), sampleRate: SAMPLE_RATE };

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
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    FakeWebSocket.reset();
    resetAudioChunkListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("streams audio recorded before the socket opened and returns the transcript on Termination", async () => {
    const { session, started, socket } = await startSession();
    emitAudioChunk(AUDIO.samples);
    expect(socket.sentAudio).toHaveLength(0);
    socket.open();
    await started;
    expect(socket.sentAudio.length).toBeGreaterThan(0);

    socket.receive({
      type: "Turn",
      end_of_turn: true,
      turn_order: 0,
      transcript: "Hello world.",
    });
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

  it("reports a failure when the socket cannot be opened", async () => {
    const { session, started, socket } = await startSession();
    socket.fail();
    await started;

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "AssemblyAI streaming session was not established: WebSocket connection failed",
    );
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when AssemblyAI closes the stream mid-recording", async () => {
    const { session, socket } = await startOpenSession();
    socket.disconnect(3005, "Session expired");

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "Connection closed during recording (code=3005, reason=Session expired)",
    );
  });

  it("reports a failure on an error message", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ error: "Invalid audio" });

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe("AssemblyAI error: Invalid audio");
  });

  it("reports a failure when the stream is not terminated in time", async () => {
    const { session } = await startOpenSession();

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(2_000);

    await expect(result).resolves.toMatchObject({
      failureReason: "AssemblyAI did not terminate the stream within 2s",
    });
  });
});
