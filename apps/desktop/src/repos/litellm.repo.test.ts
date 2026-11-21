import {
  buildLiteLLMApiUrl,
  litellmFetchModels,
  litellmTestIntegration,
} from "@voquill/voice-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { setAppState } from "../store";
import {
  getGenerateTextRepo,
  getModelProviderRepo,
  getTranscribeAudioRepo,
} from ".";
import { OpenAICompatibleGenerateTextRepo } from "./generate-text.repo";
import { OpenAICompatibleTranscribeAudioRepo } from "./transcribe-audio.repo";

// The desktop app routes provider HTTP through Tauri; in tests it is the global fetch.
vi.mock("@tauri-apps/plugin-http", () => ({
  fetch: (input: string | URL | Request, init?: RequestInit) =>
    globalThis.fetch(input, init),
}));
// Repo selection logs through the Tauri log plugin, which has no host in tests.
vi.mock("@tauri-apps/plugin-log", () => ({
  trace: async () => {},
  debug: async () => {},
  info: async () => {},
  warn: async () => {},
  error: async () => {},
}));

const PROXY_URL = "http://localhost:4000";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });

const MODEL_INFO = {
  data: [
    { model_name: "fast-chat", model_info: { mode: "chat" } },
    { model_name: "fast-chat", model_info: { mode: "chat" } },
    { model_name: "dictation", model_info: { mode: "audio_transcription" } },
    { model_name: "responses-model", model_info: { mode: "responses" } },
    { model_name: "embedder", model_info: { mode: "embedding" } },
    { model_name: "openai/*", model_info: { mode: "chat" } },
    { model_name: "legacy-alias", model_info: null },
  ],
};

const withLiteLLMKey = (
  section: "aiTranscription" | "aiPostProcessing",
  model: string | null,
) => {
  const state = structuredClone(INITIAL_APP_STATE);
  state.settings[section].mode = "api";
  state.settings[section].selectedApiKeyId = "litellm-key";
  state.apiKeyById["litellm-key"] = {
    id: "litellm-key",
    name: "LiteLLM",
    provider: "litellm",
    createdAt: "2026-11-05T00:00:00.000Z",
    keyFull: "sk-proxy",
    baseUrl: PROXY_URL,
    transcriptionModel: section === "aiTranscription" ? model : null,
    postProcessingModel: section === "aiPostProcessing" ? model : null,
  };
  setAppState(state, true);
};

beforeEach(() => {
  setAppState(structuredClone(INITIAL_APP_STATE), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("buildLiteLLMApiUrl", () => {
  it("adds /v1 once and defaults to the local proxy", () => {
    expect(buildLiteLLMApiUrl(null)).toBe("http://localhost:4000/v1");
    expect(buildLiteLLMApiUrl("https://llm.example.com/")).toBe(
      "https://llm.example.com/v1",
    );
    expect(buildLiteLLMApiUrl("https://llm.example.com/v1")).toBe(
      "https://llm.example.com/v1",
    );
  });
});

describe("litellmFetchModels", () => {
  it("splits proxy aliases by mode from /model/info", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json(MODEL_INFO));

    const models = await litellmFetchModels({
      baseUrl: `${PROXY_URL}/v1`,
      apiKey: "sk-proxy",
    });

    expect(models.generative).toEqual([
      "fast-chat",
      "legacy-alias",
      "responses-model",
    ]);
    expect(models.transcription).toEqual(["dictation"]);
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${PROXY_URL}/model/info`);
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-proxy" });
  });

  it("falls back to /v1/models when /model/info is not available", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(json({ error: "forbidden" }, 403))
      .mockResolvedValueOnce(
        json({ data: [{ id: "gpt-4.1-mini" }, { id: "openai/*" }] }),
      );

    const models = await litellmFetchModels({ baseUrl: PROXY_URL });

    expect(models).toEqual({
      generative: ["gpt-4.1-mini"],
      transcription: ["gpt-4.1-mini"],
    });
    expect(fetchMock.mock.calls[1]?.[0]).toBe(`${PROXY_URL}/v1/models`);
    // No key configured: no Authorization header at all.
    expect(fetchMock.mock.calls[1]?.[1]?.headers).toEqual({});
  });

  it("returns no models when the proxy is unreachable", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));

    await expect(litellmFetchModels({ baseUrl: PROXY_URL })).resolves.toEqual({
      generative: [],
      transcription: [],
    });
  });

  it("feeds each picker through the model provider repo", async () => {
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      json(MODEL_INFO),
    );
    const repo = getModelProviderRepo("litellm");

    expect(repo.supportsTranscriptionModels()).toBe(true);
    expect(repo.supportsGenerativeTextModels()).toBe(true);
    await expect(
      repo.getTranscriptionModels({ baseUrl: PROXY_URL }),
    ).resolves.toEqual(["dictation"]);
    await expect(
      repo.getGenerativeTextModels({ baseUrl: PROXY_URL }),
    ).resolves.toContain("fast-chat");
  });
});

describe("litellmTestIntegration", () => {
  it("accepts a reachable proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(json({ data: [] }));
    await expect(
      litellmTestIntegration({ baseUrl: PROXY_URL, apiKey: "sk-proxy" }),
    ).resolves.toBe(true);
  });

  it("explains a rejected key", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({ error: "invalid" }, 401),
    );
    await expect(
      litellmTestIntegration({ baseUrl: PROXY_URL, apiKey: "bad" }),
    ).rejects.toThrow("rejected the API key");
  });

  it("explains an unreachable proxy", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("ECONNREFUSED"));
    await expect(
      litellmTestIntegration({ baseUrl: PROXY_URL }),
    ).rejects.toThrow(
      "Could not reach the LiteLLM proxy at http://localhost:4000",
    );
  });
});

describe("LiteLLM repos", () => {
  it("transcribes through the proxy's /v1/audio/transcriptions", async () => {
    withLiteLLMKey("aiTranscription", "dictation");
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(json({ text: "hello from the proxy" }));

    const { repo, apiKeyId } = getTranscribeAudioRepo();
    const result = await repo.transcribeAudio({
      samples: new Float32Array(16000),
      sampleRate: 16000,
      language: "auto",
    });

    expect(apiKeyId).toBe("litellm-key");
    expect(repo).toBeInstanceOf(OpenAICompatibleTranscribeAudioRepo);
    expect(result.text).toBe("hello from the proxy");
    expect(result.metadata?.inferenceDevice).toBe("API • LiteLLM");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(url).toBe(`${PROXY_URL}/v1/audio/transcriptions`);
    expect(init?.headers).toEqual({ Authorization: "Bearer sk-proxy" });
    expect((init?.body as FormData).get("model")).toBe("dictation");
  });

  it("post-processes through the proxy's /v1/chat/completions", async () => {
    withLiteLLMKey("aiPostProcessing", "fast-chat");
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(
      json({
        id: "chatcmpl-1",
        object: "chat.completion",
        created: 0,
        model: "fast-chat",
        choices: [
          {
            index: 0,
            finish_reason: "stop",
            message: { role: "assistant", content: "Cleaned transcript." },
          },
        ],
      }),
    );

    const { repo, warnings } = getGenerateTextRepo();
    const output = await repo!.generateText({ prompt: "clean this" });

    expect(repo).toBeInstanceOf(OpenAICompatibleGenerateTextRepo);
    expect(warnings).toEqual([]);
    expect(output.text).toBe("Cleaned transcript.");
    expect(output.metadata?.inferenceDevice).toBe("API • LiteLLM");
    const [url, init] = fetchMock.mock.calls[0] ?? [];
    expect(String(url)).toBe(`${PROXY_URL}/v1/chat/completions`);
    expect(JSON.parse(String(init?.body)).model).toBe("fast-chat");
  });

  it("warns instead of guessing when no post-processing model is chosen", () => {
    withLiteLLMKey("aiPostProcessing", null);

    const { repo, warnings } = getGenerateTextRepo();

    expect(repo).toBeNull();
    expect(warnings).toContain(
      "No model configured for LiteLLM post-processing.",
    );
  });
});
