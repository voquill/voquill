import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { LocalTranscriptionSession } from "./local-transcription-session";
import {
  emitAudioChunk,
  flushMicrotasks,
  getAudioChunkListenerCount,
  resetAudioChunkListeners,
  recordedSamples,
} from "./streaming-session.fakes";

const createStreamingSession = vi.hoisted(() => vi.fn());

vi.mock(
  "@tauri-apps/api/event",
  async () => (await import("./streaming-session.fakes")).tauriEventMock,
);
vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);
vi.mock("../sidecars", () => ({
  getLocalTranscriptionSidecarManager: () => ({ createStreamingSession }),
}));

const AUDIO = { samples: recordedSamples(1_600), sampleRate: 16_000 };

const makeSidecarSession = () => ({
  writeAudioChunk: vi.fn(),
  finalize: vi.fn(async () => ({
    text: " local text ",
    model: "base",
    inferenceDevice: "CPU",
    durationMs: 120,
    mode: "cpu",
  })),
  cleanup: vi.fn(),
});

describe("LocalTranscriptionSession", () => {
  beforeEach(() => {
    createStreamingSession.mockReset();
    resetAudioChunkListeners();
    setAppState({ ...INITIAL_APP_STATE });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("streams audio recorded while the model loads and returns the transcript", async () => {
    const sidecar = makeSidecarSession();
    let ready: (value: typeof sidecar) => void = () => {};
    createStreamingSession.mockReturnValue(
      new Promise((resolve) => (ready = resolve)),
    );
    const session = new LocalTranscriptionSession();
    const started = session.onRecordingStart(16_000);
    await flushMicrotasks();

    emitAudioChunk([0.1]);
    ready(sidecar);
    await started;
    emitAudioChunk([0.2]);

    expect(sidecar.writeAudioChunk).toHaveBeenCalledTimes(2);
    const result = await session.finalize(AUDIO);
    expect(result).toMatchObject({
      rawTranscript: "local text",
      metadata: { transcriptionMode: "local", modelSize: "base" },
    });
    expect(result.failureReason).toBeUndefined();
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when the streaming session cannot start", async () => {
    createStreamingSession.mockRejectedValue(new Error("sidecar not running"));
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16_000);

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "Local streaming session unavailable (sidecar not running)",
    );
    expect(getAudioChunkListenerCount()).toBe(0);
  });

  it("reports a failure when streaming finalize fails", async () => {
    const sidecar = makeSidecarSession();
    sidecar.finalize.mockRejectedValue(new Error("chunk upload failed"));
    createStreamingSession.mockResolvedValue(sidecar);
    const session = new LocalTranscriptionSession();
    await session.onRecordingStart(16_000);

    const result = await session.finalize(AUDIO);
    expect(result.failureReason).toBe(
      "Local streaming transcription failed (chunk upload failed)",
    );
    expect(sidecar.cleanup).toHaveBeenCalled();
  });
});
