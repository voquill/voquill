import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import { getTranscribeAudioRepo, getModelProviderRepo } from ".";
import {
  sixtydbTranscribeAudio,
  sixtydbTestIntegration,
} from "@voquill/voice-ai";
import {
  BatchTranscriptionSession,
  createTranscriptionSession,
} from "../sessions";
import { getTranscriptionPrefs } from "../utils/user.utils";
import {
  BaseTranscribeAudioRepo,
  DeepgramTranscribeAudioRepo,
  SixtyDBTranscribeAudioRepo,
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

describe("60db transcription", () => {
  it("uploads long recordings sequentially and merges overlapping transcripts", async () => {
    let active = 0;
    let maximum = 0;
    const sizes: number[] = [];
    const texts = ["hello shared words", "shared words goodbye"];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_url, init) => {
      active++;
      maximum = Math.max(maximum, active);
      const form = init?.body;
      if (!(form instanceof FormData))
        throw new Error("Expected multipart audio");
      const file = form.get("file") as File;
      sizes.push(file.size);
      await Promise.resolve();
      active--;
      return Response.json({ text: texts[sizes.length - 1] });
    });
    const result = await new SixtyDBTranscribeAudioRepo("key").transcribeAudio({
      samples: createSamples(70, 16000),
      sampleRate: 16000,
    });
    expect(maximum).toBe(1);
    expect(sizes).toEqual([60 * 16000 * 2 + 44, 15 * 16000 * 2 + 44]);
    expect(result.text).toBe("hello shared words goodbye");
  });

  it("rejects invalid JSON without returning a transcript", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response("not JSON"));
    await expect(
      sixtydbTranscribeAudio({ apiKey: "key", blob: new ArrayBuffer(2) }),
    ).rejects.toThrow();
  });

  it("routes the selected key through batch transcription and multipart WAV", async () => {
    const state = structuredClone(INITIAL_APP_STATE);
    state.settings.aiTranscription.mode = "api";
    state.settings.aiTranscription.selectedApiKeyId = "60db-key";
    state.apiKeyById["60db-key"] = {
      id: "60db-key",
      name: "Workspace",
      provider: "sixtydb",
      createdAt: "2026-10-01T00:00:00.000Z",
      keyFull: " workspace-key ",
    };
    setAppState(state, true);
    const { repo, apiKeyId } = getTranscribeAudioRepo();
    expect(repo).toBeInstanceOf(SixtyDBTranscribeAudioRepo);
    expect(apiKeyId).toBe("60db-key");
    expect(getModelProviderRepo("sixtydb").supportsTranscriptionModels()).toBe(
      true,
    );
    expect(getModelProviderRepo("sixtydb").supportsGenerativeTextModels()).toBe(
      false,
    );
    const session = createTranscriptionSession(getTranscriptionPrefs(state));
    expect(session).toBeInstanceOf(BatchTranscriptionSession);
    expect(session.supportsStreaming()).toBe(false);
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ text: "hello caller" }));
    const result = await repo.transcribeAudio({
      samples: createSamples(1, 16000),
      sampleRate: 16000,
      language: "en-US",
    });
    expect(result).toMatchObject({
      text: "hello caller",
      metadata: {
        inferenceDevice: "API • 60db",
        modelSize: null,
        transcriptionMode: "api",
      },
    });
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.60db.ai/stt");
    expect(init?.headers).toEqual({ Authorization: "Bearer workspace-key" });
    expect(init?.redirect).toBe("error");
    const form = init?.body as FormData;
    expect(form.get("language")).toBe("en");
    expect(form.has("model")).toBe(false);
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.wav");
    expect(file.type).toBe("audio/wav");
    const wav = new Uint8Array(await file.arrayBuffer());
    expect(new TextDecoder().decode(wav.subarray(0, 4))).toBe("RIFF");
    expect(wav.length).toBeGreaterThan(32000);
    const serialized = new Request(String(url), init);
    expect(serialized.headers.get("Content-Type")).toContain(
      "multipart/form-data; boundary=",
    );
    expect((await serialized.formData()).get("language")).toBe("en");
  });

  it("preserves Buffer slice boundaries, omits automatic language and accepts silence", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(
        Response.json({ text: "", warning_codes: ["no_speech_detected"] }),
      );
    const backing = Buffer.from([99, 1, 2, 3, 88]);
    const result = await sixtydbTranscribeAudio({
      apiKey: "key",
      blob: backing.subarray(1, 4),
      language: "auto",
    });
    expect(result).toEqual({ text: "", wordsUsed: 0 });
    const form = fetchMock.mock.calls[0]![1]!.body as FormData;
    expect(form.has("language")).toBe(false);
    expect([
      ...new Uint8Array(await (form.get("file") as File).arrayBuffer()),
    ]).toEqual([1, 2, 3]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each([401, 402, 429, 503])(
    "does not retry HTTP %s or expose response contents",
    async (status) => {
      const fetchMock = vi
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response("private detail", { status }));
      await expect(
        sixtydbTranscribeAudio({
          apiKey: "secret-key",
          blob: new ArrayBuffer(2),
        }),
      ).rejects.toThrow(`status ${status}`);
      expect(fetchMock).toHaveBeenCalledTimes(1);
    },
  );

  it.each([
    null,
    [],
    {},
    { text: null },
    { text: 5 },
    { text: "bad", success: false },
    { text: "bad", error_code: "FAILED" },
  ])("rejects malformed or application error response %j", async (body) => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json(body));
    await expect(
      sixtydbTranscribeAudio({ apiKey: "key", blob: new ArrayBuffer(2) }),
    ).rejects.toThrow("invalid transcript");
  });

  it("propagates network and timeout failures without retries", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockRejectedValue(new DOMException("Request timed out", "TimeoutError"));
    await expect(
      sixtydbTranscribeAudio({ apiKey: "key", blob: new ArrayBuffer(2) }),
    ).rejects.toThrow("Request timed out");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0]![1]!.signal).toBeInstanceOf(AbortSignal);
  });

  it("rejects missing keys and invalid upload sizes before networking", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch");
    await expect(
      sixtydbTranscribeAudio({ apiKey: " ", blob: new ArrayBuffer(2) }),
    ).rejects.toThrow("key is required");
    for (const size of [0, 10_000_001]) {
      await expect(
        sixtydbTranscribeAudio({ apiKey: "key", blob: new ArrayBuffer(size) }),
      ).rejects.toThrow("at most 10 MB");
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("checks credentials without submitting audio", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(Response.json({ voices: [] }));
    expect(await sixtydbTestIntegration({ apiKey: " key " })).toBe(true);
    const [url, init] = fetchMock.mock.calls[0]!;
    expect(url).toBe("https://api.60db.ai/voices");
    expect(init?.headers).toEqual({ Authorization: "Bearer key" });
    expect(init?.body).toBeUndefined();
    fetchMock.mockResolvedValue(
      new Response("private details", { status: 401 }),
    );
    await expect(sixtydbTestIntegration({ apiKey: "key" })).rejects.toThrow(
      "status 401",
    );
  });
});
