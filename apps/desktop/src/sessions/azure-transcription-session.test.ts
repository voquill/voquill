import type { AzureStreamingSession } from "@voquill/voice-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { AzureTranscriptionSession } from "./azure-transcription-session";
import {
  emitAudioChunk,
  flushMicrotasks,
  getAudioChunkListenerCount,
  resetAudioChunkListeners,
  recordedSamples,
} from "./streaming-session.fakes";

const createAzureStreamingSession = vi.hoisted(() => vi.fn());

vi.mock(
  "@tauri-apps/api/event",
  async () => (await import("./streaming-session.fakes")).tauriEventMock,
);
vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);
vi.mock(import("@voquill/voice-ai"), async (importOriginal) => ({
  ...(await importOriginal()),
  createAzureStreamingSession,
}));

const AUDIO = { samples: recordedSamples(1_600), sampleRate: 16_000 };

const makeAzureSession = () => {
  let error: string | null = null;
  const session = {
    writeAudioChunk: vi.fn(),
    finalize: vi.fn(async () => "azure text"),
    cleanup: vi.fn(),
    getError: () => error,
  };
  return { session, setError: (value: string) => (error = value) };
};

describe("AzureTranscriptionSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.spyOn(console, "log").mockImplementation(() => {});
    vi.spyOn(console, "error").mockImplementation(() => {});
    createAzureStreamingSession.mockReset();
    resetAudioChunkListeners();
    setAppState({ ...INITIAL_APP_STATE });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it("writes audio recorded during connection setup and returns the transcript", async () => {
    const { session: azure } = makeAzureSession();
    let connect: (value: AzureStreamingSession) => void = () => {};
    createAzureStreamingSession.mockReturnValue(
      new Promise<AzureStreamingSession>((resolve) => (connect = resolve)),
    );
    const session = new AzureTranscriptionSession("key", "eastus");
    const started = session.onRecordingStart(16_000);
    await flushMicrotasks();

    emitAudioChunk([0.1, 0.2]);
    connect(azure);
    await started;
    emitAudioChunk([0.3]);

    expect(azure.writeAudioChunk).toHaveBeenCalledTimes(2);
    const result = await session.finalize(AUDIO);
    expect(result).toMatchObject({ rawTranscript: "azure text" });
    expect(result.failureReason).toBeUndefined();
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("waits for a session still connecting at stop", async () => {
    const { session: azure } = makeAzureSession();
    let connect: (value: AzureStreamingSession) => void = () => {};
    createAzureStreamingSession.mockReturnValue(
      new Promise<AzureStreamingSession>((resolve) => (connect = resolve)),
    );
    const session = new AzureTranscriptionSession("key", "eastus");
    void session.onRecordingStart(16_000);
    await flushMicrotasks();
    emitAudioChunk([0.1]);

    const result = session.finalize(AUDIO);
    connect(azure);

    await expect(result).resolves.toMatchObject({
      rawTranscript: "azure text",
    });
    expect(azure.writeAudioChunk).toHaveBeenCalledTimes(1);
  });

  it("cleans up a session that connects after the dictation was cancelled", async () => {
    const { session: azure } = makeAzureSession();
    let connect: (value: AzureStreamingSession) => void = () => {};
    createAzureStreamingSession.mockReturnValue(
      new Promise<AzureStreamingSession>((resolve) => (connect = resolve)),
    );
    const session = new AzureTranscriptionSession("key", "eastus");
    const started = session.onRecordingStart(16_000);
    await flushMicrotasks();

    session.cleanup();
    await started;
    connect(azure);
    await flushMicrotasks();

    expect(azure.cleanup).toHaveBeenCalled();
    expect(azure.writeAudioChunk).not.toHaveBeenCalled();
  });

  it("reports a failure when recognition was canceled mid-recording", async () => {
    const { session: azure, setError } = makeAzureSession();
    createAzureStreamingSession.mockResolvedValue(azure);
    const session = new AzureTranscriptionSession("key", "eastus");
    await session.onRecordingStart(16_000);

    setError("WebSocket disconnected");
    const result = await session.finalize(AUDIO);

    expect(azure.finalize).not.toHaveBeenCalled();
    expect(result.failureReason).toBe(
      "Azure streaming failed: WebSocket disconnected",
    );
  });

  it("reports a failure when recognition is canceled during finalize", async () => {
    const { session: azure, setError } = makeAzureSession();
    azure.finalize.mockImplementation(async () => {
      setError("Service timeout");
      return "partial";
    });
    createAzureStreamingSession.mockResolvedValue(azure);
    const session = new AzureTranscriptionSession("key", "eastus");
    await session.onRecordingStart(16_000);

    const result = await session.finalize(AUDIO);
    expect(result.rawTranscript).toBeNull();
    expect(result.failureReason).toBe(
      "Azure streaming failed: Service timeout",
    );
  });

  it("reports a failure when the session cannot start", async () => {
    createAzureStreamingSession.mockRejectedValue(
      new Error("401 Unauthorized"),
    );
    const session = new AzureTranscriptionSession("key", "eastus");
    await session.onRecordingStart(16_000);

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "Azure streaming session was not established: 401 Unauthorized",
    );
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure and cleans up a late session when connecting times out", async () => {
    const { session: azure } = makeAzureSession();
    let connect: (value: AzureStreamingSession) => void = () => {};
    createAzureStreamingSession.mockReturnValue(
      new Promise<AzureStreamingSession>((resolve) => (connect = resolve)),
    );
    const session = new AzureTranscriptionSession("key", "eastus");
    const started = session.onRecordingStart(16_000);
    await vi.advanceTimersByTimeAsync(10_000);
    await started;

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "Azure streaming session was not established: Timed out after 10s",
    );
    connect(azure);
    await flushMicrotasks();
    expect(azure.cleanup).toHaveBeenCalled();
  });
});
