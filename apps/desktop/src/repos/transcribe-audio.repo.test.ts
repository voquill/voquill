import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const tauriFetch = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/plugin-http", () => ({ fetch: tauriFetch }));
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { getTranscribeAudioRepo } from ".";
import {
  AssemblyAITranscribeAudioRepo,
  BaseTranscribeAudioRepo,
  DeepgramTranscribeAudioRepo,
  TranscribeAudioOutput,
  TranscribeSegmentInput,
} from "./transcribe-audio.repo";

/**
 * Mock implementation that tracks calls and returns predictable text
 * based on the segment's position in the audio.
 */
class MockTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  public segmentCalls: TranscribeSegmentInput[] = [];
  public concurrentCalls = 0;
  public maxConcurrentCalls = 0;

  constructor(
    private segmentDuration: number = 10,
    private overlapDuration: number = 2,
    private batchSize: number = 2,
    private transcriptGenerator?: (
      input: TranscribeSegmentInput,
      index: number,
    ) => string,
  ) {
    super();
  }

  protected getSegmentDurationSec(): number {
    return this.segmentDuration;
  }

  protected getOverlapDurationSec(): number {
    return this.overlapDuration;
  }

  protected getBatchChunkCount(): number {
    return this.batchSize;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const index = this.segmentCalls.length;
    this.segmentCalls.push(input);

    // Track concurrent calls
    this.concurrentCalls++;
    this.maxConcurrentCalls = Math.max(
      this.maxConcurrentCalls,
      this.concurrentCalls,
    );

    // Simulate async delay
    await new Promise((resolve) => setTimeout(resolve, 10));

    this.concurrentCalls--;

    const text = this.transcriptGenerator
      ? this.transcriptGenerator(input, index)
      : `segment ${index}`;

    return {
      text,
      metadata: {
        inferenceDevice: "Mock Device",
        modelSize: "mock",
        transcriptionMode: "local",
      },
    };
  }
}

// Helper to create samples of a specific duration
const createSamples = (durationSec: number, sampleRate: number): Float32Array =>
  new Float32Array(Math.floor(durationSec * sampleRate));

const resetStore = () => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
};

beforeEach(() => {
  resetStore();
});

afterEach(() => {
  vi.restoreAllMocks();
  resetStore();
});

describe("BaseTranscribeAudioRepo", () => {
  describe("short audio (no splitting)", () => {
    it("should transcribe directly when audio fits in one segment", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(5, sampleRate); // 5 seconds < 10 second segment

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(1);
      expect(repo.segmentCalls[0]?.samples.length).toBe(samples.length);
      expect(result.text).toBe("segment 0");
    });

    it("should transcribe directly when audio equals segment duration", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(10, sampleRate); // exactly 10 seconds

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(1);
      expect(result.text).toBe("segment 0");
    });
  });

  describe("long audio (with splitting)", () => {
    it("should split audio into overlapping segments", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3);
      const sampleRate = 16000;
      // 25 seconds of audio with 10s segments and 2s overlap (step = 8s)
      // Segments: 0-10s, 8-18s, 16-25s
      const samples = createSamples(25, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(3);

      // Verify segment sizes
      expect(repo.segmentCalls[0]?.samples.length).toBe(sampleRate * 10); // full segment
      expect(repo.segmentCalls[1]?.samples.length).toBe(sampleRate * 10); // full segment
      expect(repo.segmentCalls[2]?.samples.length).toBe(sampleRate * 9); // truncated (16-25s)
    });

    it("should merge transcriptions with overlap detection", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3, (_input, index) => {
        // Simulate overlapping transcriptions
        const transcripts = [
          "The quick brown fox",
          "brown fox jumps over",
          "jumps over the lazy dog",
        ];
        return transcripts[index] ?? "";
      });
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.text).toBe("The quick brown fox jumps over the lazy dog");
    });

    it("should concatenate when no overlap is detected", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3, (_input, index) => {
        const transcripts = ["Hello world", "Goodbye moon", "See you later"];
        return transcripts[index] ?? "";
      });
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.text).toBe("Hello world Goodbye moon See you later");
    });
  });

  describe("batching behavior", () => {
    it("should respect batch size for concurrent calls", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2); // batch size = 2
      const sampleRate = 16000;
      // 35 seconds with 10s segments and 2s overlap (step = 8s):
      // 0-10s, 8-18s, 16-26s, 24-34s, 32-35s → 5 segments
      const samples = createSamples(35, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(5);
      // Max concurrent should not exceed batch size
      expect(repo.maxConcurrentCalls).toBeLessThanOrEqual(2);
    });

    it("should process single-threaded with batch size 1", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 1); // batch size = 1
      const sampleRate = 16000;
      const samples = createSamples(35, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.maxConcurrentCalls).toBe(1);
    });

    it("should allow higher parallelism with larger batch size", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 4); // batch size = 4
      const sampleRate = 16000;
      // 26 seconds with 10s segments and 2s overlap (step = 8s):
      // 0-10s, 8-18s, 16-26s → 3 segments (all fit in one batch)
      const samples = createSamples(26, sampleRate);

      await repo.transcribeAudio({ samples, sampleRate });

      expect(repo.segmentCalls).toHaveLength(3);
      // With 3 segments and batch size 4, all should run concurrently
      expect(repo.maxConcurrentCalls).toBe(3);
    });
  });

  describe("edge cases", () => {
    it("should handle empty samples", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);

      const result = await repo.transcribeAudio({
        samples: new Float32Array(0),
        sampleRate: 16000,
      });

      expect(result.text).toBe("");
      expect(repo.segmentCalls).toHaveLength(0);
    });

    it("should handle null/undefined samples", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);

      const result = await repo.transcribeAudio({
        samples: null,
        sampleRate: 16000,
      });

      expect(result.text).toBe("");
      expect(repo.segmentCalls).toHaveLength(0);
    });

    it("should pass prompt and language to each segment", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate); // 3 segments

      await repo.transcribeAudio({
        samples,
        sampleRate,
        prompt: "technical terms",
        language: "en",
      });

      expect(repo.segmentCalls).toHaveLength(3);
      for (const call of repo.segmentCalls) {
        expect(call.prompt).toBe("technical terms");
        expect(call.language).toBe("en");
      }
    });

    it("should return metadata from first segment", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 2);
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.metadata).toEqual({
        inferenceDevice: "Mock Device",
        modelSize: "mock",
        transcriptionMode: "local",
      });
    });
  });

  describe("realistic scenario", () => {
    it("should handle 2-minute audio with realistic settings", async () => {
      // Simulate API-like settings: 60s segments, 5s overlap, batch of 3
      const repo = new MockTranscribeAudioRepo(60, 5, 3, (_input, index) => {
        // Simulate realistic overlapping speech
        const transcripts = [
          "In the beginning there was silence and then came the sound",
          "came the sound of voices speaking softly in the distance",
          "speaking softly in the distance growing louder with each passing moment",
        ];
        return transcripts[index] ?? `segment ${index}`;
      });
      const sampleRate = 16000;
      const samples = createSamples(120, sampleRate); // 2 minutes

      const result = await repo.transcribeAudio({ samples, sampleRate });

      // With 60s segments and 55s step (60-5), we get:
      // 0-60s, 55-115s, 110-120s
      expect(repo.segmentCalls).toHaveLength(3);

      // Verify overlap merging worked
      expect(result.text).toBe(
        "In the beginning there was silence and then came the sound of voices speaking softly in the distance growing louder with each passing moment",
      );
    });
  });
});

describe("DeepgramTranscribeAudioRepo", () => {
  it("requests Deepgram language detection for automatic language", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      new Response(
        JSON.stringify({
          results: {
            channels: [
              {
                alternatives: [{ transcript: "bonjour tout le monde" }],
              },
            ],
          },
        }),
        { status: 200 },
      ),
    );
    const repo = new DeepgramTranscribeAudioRepo("dg-key", null);

    const result = await repo.transcribeAudio({
      samples: createSamples(1, 16000),
      sampleRate: 16000,
      language: "auto",
    });

    const [url, init] = fetchMock.mock.calls[0] ?? [];
    const requestUrl = new URL(String(url));

    expect(result.text).toBe("bonjour tout le monde");
    expect(requestUrl.searchParams.get("detect_language")).toBe("true");
    expect(requestUrl.searchParams.has("language")).toBe(false);
    expect(init?.headers).toMatchObject({
      Authorization: "Token dg-key",
      "Content-Type": "audio/wav",
    });
  });

  it("is selected for Deepgram API transcription preferences", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "deepgram-key";
    state.apiKeyById["deepgram-key"] = {
      id: "deepgram-key",
      name: "Deepgram",
      provider: "deepgram",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: "dg-key",
      transcriptionModel: "nova-3",
    };
    setAppState(state, true);

    const { repo, apiKeyId } = getTranscribeAudioRepo();

    expect(repo).toBeInstanceOf(DeepgramTranscribeAudioRepo);
    expect(apiKeyId).toBe("deepgram-key");
  });
});

describe("AssemblyAITranscribeAudioRepo", () => {
  const jsonResponse = (body: unknown) =>
    new Response(JSON.stringify(body), { status: 200 });

  beforeEach(() => {
    vi.useFakeTimers();
    tauriFetch.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("uploads the audio, then polls until the transcript is complete", async () => {
    tauriFetch
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://cdn/a.wav" }))
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "queued" }))
      .mockResolvedValueOnce(jsonResponse({ id: "t1", status: "processing" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "t1", status: "completed", text: "Hello there." }),
      );
    const repo = new AssemblyAITranscribeAudioRepo("aai-key");

    const pending = repo.transcribeAudio({
      samples: createSamples(1, 16000),
      sampleRate: 16000,
      language: "en",
    });
    await vi.advanceTimersByTimeAsync(2_000);
    const result = await pending;

    expect(result.text).toBe("Hello there.");
    const [uploadUrl, uploadInit] = tauriFetch.mock.calls[0];
    expect(uploadUrl).toBe("https://api.assemblyai.com/v2/upload");
    expect(uploadInit.headers).toMatchObject({ authorization: "aai-key" });
    expect(JSON.parse(tauriFetch.mock.calls[1][1].body)).toEqual({
      audio_url: "https://cdn/a.wav",
      language_code: "en",
    });
    expect(tauriFetch.mock.calls[3][0]).toBe(
      "https://api.assemblyai.com/v2/transcript/t1",
    );
  });

  it("requests language detection for automatic language", async () => {
    tauriFetch
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://cdn/a.wav" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "t1", status: "completed", text: "Hola." }),
      );
    const repo = new AssemblyAITranscribeAudioRepo("aai-key");

    await repo.transcribeAudio({
      samples: createSamples(1, 16000),
      sampleRate: 16000,
      language: "auto",
    });

    expect(JSON.parse(tauriFetch.mock.calls[1][1].body)).toEqual({
      audio_url: "https://cdn/a.wav",
      language_detection: true,
    });
  });

  it("throws when AssemblyAI reports a transcription error", async () => {
    tauriFetch
      .mockResolvedValueOnce(jsonResponse({ upload_url: "https://cdn/a.wav" }))
      .mockResolvedValueOnce(
        jsonResponse({ id: "t1", status: "error", error: "Audio too short" }),
      );
    const repo = new AssemblyAITranscribeAudioRepo("aai-key");

    await expect(
      repo.transcribeAudio({
        samples: createSamples(1, 16000),
        sampleRate: 16000,
      }),
    ).rejects.toThrow("AssemblyAI transcription failed: Audio too short");
  });

  it("is selected for AssemblyAI API transcription preferences", () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "aai-key";
    state.apiKeyById["aai-key"] = {
      id: "aai-key",
      name: "AssemblyAI",
      provider: "assemblyai",
      createdAt: "2026-06-03T00:00:00.000Z",
      keyFull: "aai-secret",
      transcriptionModel: null,
    };
    setAppState(state, true);

    const { repo } = getTranscribeAudioRepo();

    expect(repo).toBeInstanceOf(AssemblyAITranscribeAudioRepo);
  });
});
