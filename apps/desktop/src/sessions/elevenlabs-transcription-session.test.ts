import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
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
// 100ms of audio: exactly one maximum-size chunk, so nothing stays buffered.
const AUDIO = { samples: recordedSamples(1_600), sampleRate: SAMPLE_RATE };

const fetchMock = vi.fn();

const tokenResponse = () => ({
  ok: true,
  json: async () => ({ token: "single-use" }),
});

const startSession = async () => {
  const session = new ElevenLabsTranscriptionSession("xi-key");
  const started = session.onRecordingStart(SAMPLE_RATE);
  await flushMicrotasks();
  return { session, started };
};

const startOpenSession = async () => {
  const { session, started } = await startSession();
  const socket = FakeWebSocket.latest;
  socket.open();
  await started;
  return { session, socket };
};

const sentChunks = (socket: FakeWebSocket) =>
  socket.sentMessages.filter((m) => m.message_type === "input_audio_chunk");

describe("ElevenLabsTranscriptionSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue(tokenResponse());
    FakeWebSocket.reset();
    resetAudioChunkListeners();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("streams audio recorded during the token fetch and commits the final chunk", async () => {
    const { session, started } = await startSession();
    emitAudioChunk(recordedSamples(800));
    const socket = FakeWebSocket.latest;
    socket.open();
    await started;

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    expect(sentChunks(socket).at(-1)).toMatchObject({ commit: true });
    socket.receive({ message_type: "committed_transcript", text: "hi there" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "hi there" });
    expect((await result).failureReason).toBeUndefined();
  });

  it("still sends a final commit when nothing is buffered at stop", async () => {
    const { session, socket } = await startOpenSession();
    emitAudioChunk(AUDIO.samples);
    expect(sentChunks(socket)).toHaveLength(1);
    expect(sentChunks(socket)[0]).toMatchObject({ commit: false });

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    expect(sentChunks(socket)).toHaveLength(2);
    expect(sentChunks(socket)[1]).toMatchObject({ commit: true });
    socket.receive({ message_type: "committed_transcript", text: "done" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "done" });
  });

  it("completes when everything was already committed and nothing more arrives", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ message_type: "partial_transcript", text: "hi" });
    socket.receive({ message_type: "committed_transcript", text: "hi" });

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toMatchObject({ rawTranscript: "hi" });
    expect((await result).failureReason).toBeUndefined();
  });

  it("completes at once when ElevenLabs reports there was nothing left to commit", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ message_type: "committed_transcript", text: "hi" });

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.receive({ message_type: "insufficient_audio_activity" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "hi" });
  });

  it("reports a failure when speech was still uncommitted at the timeout", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ message_type: "partial_transcript", text: "unfinished" });

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "ElevenLabs did not finish within 6s",
    });
  });

  it("reports a failure and stops listening when the token request fails", async () => {
    fetchMock.mockResolvedValue({
      ok: false,
      status: 401,
      text: async () => "invalid key",
    });
    const { session, started } = await startSession();
    await started;

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toContain("Failed to get ElevenLabs token");
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("aborts a hung token request after 10s and never opens a socket", async () => {
    let tokenSignal: AbortSignal | undefined;
    fetchMock.mockImplementation(
      (_url: string, init: RequestInit) =>
        new Promise((_resolve, reject) => {
          tokenSignal = init.signal ?? undefined;
          tokenSignal?.addEventListener("abort", () =>
            reject(new Error("aborted")),
          );
        }),
    );
    const { session, started } = await startSession();
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "ElevenLabs not ready within 10s",
    });
    expect(tokenSignal?.aborted).toBe(true);
    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("does not open a socket or stream when cleaned up during the token fetch", async () => {
    let resolveToken: (value: unknown) => void = () => {};
    fetchMock.mockReturnValue(
      new Promise((resolve) => (resolveToken = resolve)),
    );
    const { session, started } = await startSession();
    emitAudioChunk(AUDIO.samples);

    session.cleanup();
    resolveToken(tokenResponse());
    await started;

    expect(FakeWebSocket.instances).toHaveLength(0);
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when the socket drops mid-recording", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ message_type: "committed_transcript", text: "hi" });
    socket.disconnect(1006);

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "Connection closed abnormally (code=1006)",
    });
  });

  it("reports a failure on a provider error message", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({
      message_type: "quota_exceeded_error",
      error: "No credits",
    });

    await expect(session.finalize(AUDIO)).resolves.toMatchObject({
      failureReason: "ElevenLabs quota_exceeded_error: No credits",
    });
  });
});
