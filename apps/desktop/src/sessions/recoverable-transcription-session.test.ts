import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { RecoverableTranscriptionSession } from "./recoverable-transcription-session";
import { recordedSamples, transcribeResult } from "./streaming-session.fakes";

vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);

const AUDIO: StopRecordingResponse = {
  samples: recordedSamples(16_000),
  sampleRate: 16_000,
};

const streamedResult = (text: string): TranscriptionSessionResult => ({
  rawTranscript: text,
  processedTranscript: `${text} (processed)`,
  metadata: { transcriptionMode: "cloud" },
  warnings: [],
});

const failedResult = (failureReason: string): TranscriptionSessionResult => ({
  rawTranscript: null,
  metadata: { transcriptionMode: "cloud" },
  warnings: [],
  failureReason,
});

const makeInner = (
  finalize: TranscriptionSession["finalize"],
  onRecordingStart: TranscriptionSession["onRecordingStart"] = async () => {},
) => ({
  onRecordingStart: vi.fn(onRecordingStart),
  finalize: vi.fn(finalize),
  cleanup: vi.fn(),
  supportsStreaming: () => true,
  setInterimResultCallback: vi.fn(),
});

describe("RecoverableTranscriptionSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("returns a complete streamed transcript untouched without re-transcribing", async () => {
    const inner = makeInner(async () => streamedResult("hello world"));
    const transcribe = vi.fn();
    const session = new RecoverableTranscriptionSession(inner, { transcribe });

    await session.onRecordingStart(16_000);
    const result = await session.finalize(AUDIO);

    expect(result).toEqual(streamedResult("hello world"));
    expect(transcribe).not.toHaveBeenCalled();
    expect(inner.cleanup).not.toHaveBeenCalled();
  });

  it("re-transcribes the full recording once when the stream reports a failure", async () => {
    const inner = makeInner(async () =>
      failedResult("Connection lost during recording"),
    );
    const transcribe = vi.fn(async () => transcribeResult("recovered text"));
    const session = new RecoverableTranscriptionSession(inner, { transcribe });

    const result = await session.finalize(AUDIO);

    expect(inner.cleanup).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(transcribe).toHaveBeenCalledWith({
      samples: AUDIO.samples,
      sampleRate: 16_000,
    });
    expect(result.rawTranscript).toBe("recovered text");
    expect(result.processedTranscript).toBeUndefined();
    expect(result.recovered).toBe(true);
    expect(result.failureReason).toBeUndefined();
    expect(result.warnings[0]).toContain("Connection lost during recording");
  });

  it("recovers when the streaming session failed to start", async () => {
    const inner = makeInner(
      async () => streamedResult("unused"),
      async () => {
        throw new Error("WebSocket connection failed");
      },
    );
    const transcribe = vi.fn(async () => transcribeResult("recovered text"));
    const session = new RecoverableTranscriptionSession(inner, { transcribe });

    await expect(session.onRecordingStart(16_000)).resolves.toBeUndefined();
    const result = await session.finalize(AUDIO);

    expect(inner.finalize).not.toHaveBeenCalled();
    expect(result.rawTranscript).toBe("recovered text");
    expect(result.recovered).toBe(true);
  });

  it("recovers when finalize throws", async () => {
    const inner = makeInner(async () => {
      throw new Error("boom");
    });
    const transcribe = vi.fn(async () => transcribeResult("recovered text"));
    const session = new RecoverableTranscriptionSession(inner, { transcribe });

    const result = await session.finalize(AUDIO);

    expect(result.rawTranscript).toBe("recovered text");
    expect(result.warnings[0]).toContain("boom");
  });

  it("retries after a failed recovery attempt", async () => {
    const inner = makeInner(async () => failedResult("dropped"));
    const transcribe = vi
      .fn()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValueOnce(transcribeResult("second try"));
    const session = new RecoverableTranscriptionSession(inner, {
      transcribe,
      retryDelayMs: 1_000,
    });

    const pending = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(result.rawTranscript).toBe("second try");
    expect(result.recovered).toBe(true);
    expect(result.warnings).toContain("Recovery attempt 1 failed: offline");
  });

  it("reports a failure with the audio kept when every attempt fails", async () => {
    const inner = makeInner(async () => failedResult("dropped"));
    const transcribe = vi.fn(async () => {
      throw new Error("offline");
    });
    const session = new RecoverableTranscriptionSession(inner, {
      transcribe,
      maxAttempts: 2,
      retryDelayMs: 1_000,
    });

    const pending = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(result.rawTranscript).toBeNull();
    expect(result.recovered).toBeUndefined();
    expect(result.failureReason).toBe("offline");
    expect(result.warnings).toEqual([
      "Transcript incomplete (dropped); re-transcribed the recorded audio",
      "Recovery attempt 1 failed: offline",
      "Recovery attempt 2 failed: offline",
    ]);
  });

  it("bounds each recovery attempt with a timeout scaled to the audio length", async () => {
    const inner = makeInner(async () => failedResult("dropped"));
    const transcribe = vi
      .fn()
      .mockReturnValueOnce(new Promise(() => {}))
      .mockResolvedValueOnce(transcribeResult("after timeout"));
    const getAttemptTimeoutMs = vi.fn(() => 5_000);
    const session = new RecoverableTranscriptionSession(inner, {
      transcribe,
      retryDelayMs: 1_000,
      getAttemptTimeoutMs,
    });

    const pending = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(transcribe).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_000);
    const result = await pending;

    expect(getAttemptTimeoutMs).toHaveBeenCalledWith(1_000);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(result.rawTranscript).toBe("after timeout");
    expect(result.warnings).toContain(
      "Recovery attempt 1 failed: Timed out after 5s",
    );
  });

  it("does not time out recovery when no attempt timeout is configured", async () => {
    const inner = makeInner(async () => failedResult("local sidecar crashed"));
    let finish: (value: ReturnType<typeof transcribeResult>) => void = () => {};
    const transcribe = vi.fn(
      () =>
        new Promise<ReturnType<typeof transcribeResult>>((r) => (finish = r)),
    );
    const session = new RecoverableTranscriptionSession(inner, {
      transcribe,
      getAttemptTimeoutMs: null,
    });

    const pending = session.finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    finish(transcribeResult("slow local whisper"));
    const result = await pending;

    expect(transcribe).toHaveBeenCalledTimes(1);
    expect(result.rawTranscript).toBe("slow local whisper");
  });

  it("reports nothing lost when there was no recorded audio", async () => {
    const inner = makeInner(async () => failedResult("dropped"));
    const transcribe = vi.fn();
    const session = new RecoverableTranscriptionSession(inner, { transcribe });

    const result = await session.finalize({ samples: [], sampleRate: 0 });

    expect(transcribe).not.toHaveBeenCalled();
    expect(result.rawTranscript).toBeNull();
    expect(result.failureReason).toBeUndefined();
  });

  it("treats an empty recovered transcript as silence, not failure", async () => {
    const inner = makeInner(async () => failedResult("dropped"));
    const transcribe = vi.fn(async () => transcribeResult(""));
    const session = new RecoverableTranscriptionSession(inner, { transcribe });

    const result = await session.finalize(AUDIO);

    expect(result.rawTranscript).toBeNull();
    expect(result.failureReason).toBeUndefined();
  });
});
