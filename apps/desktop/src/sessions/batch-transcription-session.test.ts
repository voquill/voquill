import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BatchTranscriptionSession } from "./batch-transcription-session";
import { recordedSamples, transcribeResult } from "./streaming-session.fakes";

const transcribeAudio = vi.hoisted(() => vi.fn());

vi.mock(import("../actions/transcribe.actions"), async (importOriginal) => ({
  ...(await importOriginal()),
  transcribeAudio,
}));
vi.mock(
  "../utils/log.utils",
  async () => (await import("./streaming-session.fakes")).logUtilsMock,
);

const AUDIO = { samples: recordedSamples(16_000), sampleRate: 16_000 };

describe("BatchTranscriptionSession", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    transcribeAudio.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("transcribes the recorded audio", async () => {
    transcribeAudio.mockResolvedValue(transcribeResult("batch text"));

    const result = await new BatchTranscriptionSession().finalize(AUDIO);

    expect(transcribeAudio).toHaveBeenCalledWith({
      samples: AUDIO.samples,
      sampleRate: 16_000,
    });
    expect(result.rawTranscript).toBe("batch text");
    expect(result.failureReason).toBeUndefined();
  });

  it("reports a failure instead of dropping the dictation when transcription fails", async () => {
    transcribeAudio.mockRejectedValue(new Error("502 Bad Gateway"));

    const result = await new BatchTranscriptionSession().finalize(AUDIO);

    expect(result.rawTranscript).toBeNull();
    expect(result.failureReason).toBe("Transcription failed: 502 Bad Gateway");
  });

  it("reports a failure when transcription hangs", async () => {
    transcribeAudio.mockReturnValue(new Promise(() => {}));

    const result = new BatchTranscriptionSession().finalize(AUDIO);
    await vi.advanceTimersByTimeAsync(20_250);

    await expect(result).resolves.toMatchObject({
      failureReason: "Transcription failed: Timed out after 20s",
    });
  });
});
