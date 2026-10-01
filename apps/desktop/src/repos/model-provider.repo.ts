import {
  AZURE_OPENAI_MODELS,
  CEREBRAS_MODELS,
  CLAUDE_MODELS,
  DEEPGRAM_TRANSCRIPTION_MODELS,
  DEEPSEEK_MODELS,
  GEMINI_GENERATE_TEXT_MODELS,
  GEMINI_TRANSCRIPTION_MODELS,
  XAI_TRANSCRIPTION_MODELS,
} from "@voquill/voice-ai";
import { fetch } from "@tauri-apps/plugin-http";
import { getOllamaHeaders } from "../utils/ollama.utils";
import { BaseRepo } from "./base.repo";

type OpenAIListResponse = {
  data?: Array<{ id?: string }>;
};

type GeminiListResponse = {
  models?: Array<{ name?: string }>;
};

export type FetchModelsOptions = {
  apiKey?: string;
  baseUrl?: string;
};

export abstract class BaseModelProviderRepo extends BaseRepo {
  abstract supportsGenerativeTextModels(): boolean;
  abstract supportsTranscriptionModels(): boolean;
  abstract getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]>;
  abstract getTranscriptionModels(
    options: FetchModelsOptions,
  ): Promise<string[]>;
}

async function fetchOpenAICompatibleModels(
  url: string,
  apiKey: string,
): Promise<string[]> {
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${apiKey}` },
  });
  if (!response.ok) return [];
  const payload = (await response.json()) as OpenAIListResponse;
  return (payload.data ?? [])
    .map((m) => (m.id ?? "").trim())
    .filter(Boolean)
    .sort();
}

function isWhisperModel(modelId: string): boolean {
  return modelId.includes("whisper");
}

function isOpenAITranscriptionModel(modelId: string): boolean {
  return isWhisperModel(modelId) || modelId.includes("transcribe");
}

function filterFetchedModels(
  fetched: string[],
  allowList: readonly string[],
): string[] {
  if (fetched.length === 0) return [...allowList];
  const allowed = new Set<string>(allowList);
  const filtered = fetched.filter((m) => allowed.has(m));
  return filtered.length > 0 ? filtered : [...allowList];
}

export class GroqModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "https://api.groq.com/openai/v1/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.filter((m) => !isWhisperModel(m));
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.filter(isWhisperModel);
  }
}

export class OpenAIModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "https://api.openai.com/v1/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.filter((m) => !isOpenAITranscriptionModel(m));
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.filter(isOpenAITranscriptionModel);
  }
}

export class ClaudeModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    const response = await fetch(
      "https://api.anthropic.com/v1/models?limit=100",
      {
        headers: {
          "x-api-key": options.apiKey,
          "anthropic-version": "2023-06-01",
        },
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as OpenAIListResponse;
    return (payload.data ?? [])
      .map((m) => (m.id ?? "").trim())
      .filter(Boolean)
      .sort();
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...CLAUDE_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class CerebrasModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "https://api.cerebras.ai/v1/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...CEREBRAS_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class DeepSeekModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "https://api.deepseek.com/models",
      options.apiKey,
    );
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...DEEPSEEK_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class GeminiModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return filterFetchedModels(fetched, GEMINI_GENERATE_TEXT_MODELS);
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return filterFetchedModels(fetched, GEMINI_TRANSCRIPTION_MODELS);
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey) return [];
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(options.apiKey)}&pageSize=1000`,
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as GeminiListResponse;
    return (payload.models ?? [])
      .map((m) => (m.name ?? "").replace(/^models\//, "").trim())
      .filter(Boolean)
      .sort();
  }
}

export class AzureModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    const fetched = await this.fetchModels(options);
    return fetched.length > 0 ? fetched : [...AZURE_OPENAI_MODELS];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.apiKey || !options.baseUrl) return [];
    const baseUrl = options.baseUrl.replace(/\/$/, "");
    const response = await fetch(
      `${baseUrl}/openai/models?api-version=2024-10-21`,
      {
        headers: { "api-key": options.apiKey },
      },
    );
    if (!response.ok) return [];
    const payload = (await response.json()) as OpenAIListResponse;
    return (payload.data ?? [])
      .map((m) => (m.id ?? "").trim())
      .filter(Boolean)
      .sort();
  }
}

export class OllamaModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    return this.fetchModels(options);
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    return this.fetchModels(options);
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl) return [];
    const response = await fetch(new URL("/api/tags", options.baseUrl).href, {
      headers: getOllamaHeaders(options.apiKey),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as {
      models?: Array<{ name?: string }>;
    };
    return (payload.models ?? [])
      .map((m) => (m.name ?? "").trim())
      .filter(Boolean);
  }
}

export class OpenAICompatibleModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    return this.fetchModels(options);
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    return this.fetchModels(options);
  }

  private async fetchModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl) return [];
    const response = await fetch(new URL("/v1/models", options.baseUrl).href, {
      headers: getOllamaHeaders(options.apiKey),
    });
    if (!response.ok) return [];
    const payload = (await response.json()) as OpenAIListResponse;
    return (payload.data ?? [])
      .map((m) => (m.id ?? "").trim())
      .filter(Boolean)
      .sort();
  }
}

export class SpeachesModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(options: FetchModelsOptions): Promise<string[]> {
    if (!options.baseUrl) return [];
    const response = await fetch(new URL("/v1/models", options.baseUrl).href);
    if (!response.ok) return [];
    const payload = (await response.json()) as OpenAIListResponse;
    return (payload.data ?? [])
      .map((m) => (m.id ?? "").trim())
      .filter(Boolean)
      .sort();
  }
}

export class OpenRouterModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return true;
  }

  supportsTranscriptionModels(): boolean {
    return false;
  }

  async getGenerativeTextModels(
    options: FetchModelsOptions,
  ): Promise<string[]> {
    if (!options.apiKey) return [];
    return fetchOpenAICompatibleModels(
      "https://openrouter.ai/api/v1/models",
      options.apiKey,
    );
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class AldeaModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class SixtyDBModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class AssemblyAIModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class ElevenLabsModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [];
  }
}

export class XaiModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [...XAI_TRANSCRIPTION_MODELS];
  }
}

export class DeepgramModelProviderRepo extends BaseModelProviderRepo {
  supportsGenerativeTextModels(): boolean {
    return false;
  }

  supportsTranscriptionModels(): boolean {
    return true;
  }

  async getGenerativeTextModels(): Promise<string[]> {
    return [];
  }

  async getTranscriptionModels(): Promise<string[]> {
    return [...DEEPGRAM_TRANSCRIPTION_MODELS];
  }
}
