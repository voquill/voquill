import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { collectDictionaryEntriesMock, getIdTokenMock, xaiTranscribeAudioMock } =
  vi.hoisted(() => ({
  collectDictionaryEntriesMock: vi.fn(() => ({
    sources: ["Acme", "Voquill"],
    replacements: [],
  })),
  getIdTokenMock: vi.fn(async () => "test-id-token"),
  xaiTranscribeAudioMock: vi.fn(async () => ({
    text: "xai transcript",
    wordsUsed: 2,
  })),
}));

vi.mock("@voquill/voice-ai", async () => {
  const actual =
    await vi.importActual<typeof import("@voquill/voice-ai")>(
      "@voquill/voice-ai",
    );

  return {
    ...actual,
    xaiTranscribeAudio: xaiTranscribeAudioMock,
  };
});

vi.mock("../store", () => ({
  getAppState: () => ({}),
}));

vi.mock("../utils/auth.utils", () => ({
  getEffectiveAuth: () => ({
    currentUser: {
      getIdToken: getIdTokenMock,
    },
  }),
}));

vi.mock("../utils/prompt.utils", () => ({
  collectDictionaryEntries: collectDictionaryEntriesMock,
}));

import {
  BaseTranscribeAudioRepo,
  GroqTranscribeAudioRepo,
  NewServerTranscribeAudioRepo,
  OpenAICompatibleTranscribeAudioRepo,
  TranscribeAudioOutput,
  TranscribeSegmentInput,
  XaiTranscribeAudioRepo,
} from "./transcribe-audio.repo";

class MockWebSocket {
  static instances: MockWebSocket[] = [];
  static OPEN = 1;

  public onopen: ((event: unknown) => void | Promise<void>) | null = null;
  public onmessage: ((event: { data: string }) => void) | null = null;
  public onerror: ((event: unknown) => void) | null = null;
  public onclose: ((event: unknown) => void) | null = null;
  public readonly sentMessages: unknown[] = [];
  public readyState = MockWebSocket.OPEN;
  public closed = false;

  constructor(public readonly url: string) {
    MockWebSocket.instances.push(this);
  }

  send(data: unknown): void {
    this.sentMessages.push(data);
  }

  close(): void {
    this.closed = true;
  }
}

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

    it("should prefer authoritative later segment text over fuzzy overlap guesses", async () => {
      const repo = new MockTranscribeAudioRepo(10, 2, 3, (_input, index) => {
        const transcripts = [
          "I think that's rea",
          "that is really helpful",
          "really helpful for everyone",
        ];
        return transcripts[index] ?? "";
      });
      const sampleRate = 16000;
      const samples = createSamples(25, sampleRate);

      const result = await repo.transcribeAudio({ samples, sampleRate });

      expect(result.text).toBe(
        "I think that is really helpful for everyone",
      );
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

describe("NewServerTranscribeAudioRepo", () => {
  beforeEach(() => {
    MockWebSocket.instances = [];
    getIdTokenMock.mockClear();
    collectDictionaryEntriesMock.mockClear();
    vi.stubGlobal("WebSocket", MockWebSocket);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the transcription prompt in the websocket config after authentication", async () => {
    const repo = new NewServerTranscribeAudioRepo();
    const transcriptionPromise = repo.transcribeAudio({
      samples: new Float32Array([0.1, -0.1, 0.2]),
      sampleRate: 16000,
      prompt: "Glossary: Acme",
      language: "en",
    });

    const ws = MockWebSocket.instances[0];
    expect(ws?.url).toContain("/v1/transcribe-raw");

    await ws?.onopen?.({});

    expect(getIdTokenMock).toHaveBeenCalledTimes(1);
    expect(ws?.sentMessages[0]).toBe(
      JSON.stringify({
        type: "auth",
        idToken: "test-id-token",
      }),
    );

    ws?.onmessage?.({
      data: JSON.stringify({ type: "authenticated" }),
    });

    expect(collectDictionaryEntriesMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(ws?.sentMessages[1] as string)).toMatchObject({
      type: "config",
      sampleRate: 16000,
      glossary: ["Acme", "Voquill"],
      language: "en",
      prompt: "Glossary: Acme",
    });

    ws?.onmessage?.({
      data: JSON.stringify({ type: "ready" }),
    });
    ws?.onmessage?.({
      data: JSON.stringify({ type: "transcript", text: "done" }),
    });

    await expect(transcriptionPromise).resolves.toEqual({
      text: "done",
      metadata: {
        transcriptionMode: "cloud",
      },
    });
  });

  it("treats fallback websocket transcription as prompt-fallback only, while xAI, Groq, and OpenAI-compatible paths support prompt hints", () => {
    const fallbackRepo = new NewServerTranscribeAudioRepo() as {
      supportsPromptHints?: () => boolean;
    };
    const xaiRepo = new XaiTranscribeAudioRepo("test-api-key", "grok-stt") as {
      supportsPromptHints?: () => boolean;
    };
    const groqRepo = new GroqTranscribeAudioRepo(
      "test-api-key",
      "whisper-large-v3-turbo",
    ) as {
      supportsPromptHints?: () => boolean;
    };
    const compatibleRepo = new OpenAICompatibleTranscribeAudioRepo(
      "https://example.com",
      "whisper-1",
      "test-api-key",
    ) as {
      supportsPromptHints?: () => boolean;
    };

    expect(fallbackRepo.supportsPromptHints?.()).toBe(false);
    expect(xaiRepo.supportsPromptHints?.()).toBe(true);
    expect(groqRepo.supportsPromptHints?.()).toBe(true);
    expect(compatibleRepo.supportsPromptHints?.()).toBe(true);
  });
});

describe("XaiTranscribeAudioRepo", () => {
  it("passes prompt and language to the xAI transcription request", async () => {
    const repo = new XaiTranscribeAudioRepo("test-api-key", "grok-stt");

    await repo.transcribeAudio({
      samples: new Float32Array([0.1, -0.1, 0.2]),
      sampleRate: 16000,
      prompt: "Glossary: Acme",
      language: "en",
    });

    expect(xaiTranscribeAudioMock).toHaveBeenCalledTimes(1);
    expect(xaiTranscribeAudioMock).toHaveBeenCalledWith(
      expect.objectContaining({
        apiKey: "test-api-key",
        model: "grok-stt",
        ext: "wav",
        prompt: "Glossary: Acme",
        language: "en",
      }),
    );
  });
});
