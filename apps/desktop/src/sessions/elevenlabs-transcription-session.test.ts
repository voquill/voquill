import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
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

const fetchMock = vi.fn();

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

describe("ElevenLabsTranscriptionSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.stubGlobal("WebSocket", FakeWebSocket);
    vi.stubGlobal("fetch", fetchMock);
    fetchMock.mockReset();
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ token: "single-use" }),
    });
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

  it("streams audio recorded during the token fetch and returns the committed transcript", async () => {
    emitAudioChunk([0]);
    const { session, started } = await startSession();
    emitAudioChunk(AUDIO.samples);
    const socket = FakeWebSocket.latest;
    socket.open();
    await started;
    expect(socket.sent.length).toBeGreaterThan(0);

    const result = session.finalize(AUDIO);
    await flushMicrotasks();
    socket.receive({ message_type: "committed_transcript", text: "hi there" });

    await expect(result).resolves.toMatchObject({ rawTranscript: "hi there" });
    expect((await result).failureReason).toBeUndefined();
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

  it("reports a failure when the socket drops mid-recording", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ message_type: "committed_transcript", text: "hi" });
    socket.disconnect(1006);

    const result = await session.finalize(AUDIO);
    expect(result.rawTranscript).toBeNull();
    expect(result.failureReason).toBe(
      "Connection closed abnormally (code=1006)",
    );
  });

  it("reports a failure on a provider error message", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({
      message_type: "quota_exceeded_error",
      error: "No credits",
    });

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "ElevenLabs quota_exceeded_error: No credits",
    );
  });

  it("reports a failure when the final transcript is never committed", async () => {
    const { session, socket } = await startOpenSession();
    socket.receive({ message_type: "partial_transcript", text: "unfinished" });

    const result = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(6_000);

    await expect(result).resolves.toMatchObject({
      rawTranscript: null,
      failureReason: "ElevenLabs did not commit the final transcript within 6s",
    });
  });
});
