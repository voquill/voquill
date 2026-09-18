import type { Nullable } from "./common.types";
import type { OpenRouterConfig } from "./openrouter.types";

export const API_KEY_PROVIDERS = [
  "groq",
  "openai",
  "aldea",
  "assemblyai",
  "elevenlabs",
  "deepgram",
  "openrouter",
  "ollama",
  "openai-compatible",
  "azure",
  "deepseek",
  "gemini",
  "claude",
  "cerebras",
  "speaches",
  "xai",
  "inferenceapis",
] as const;
export type ApiKeyProvider = (typeof API_KEY_PROVIDERS)[number];

export type ApiKey = {
  id: string;
  name: string;
  provider: ApiKeyProvider;
  createdAt: string;
  keySuffix?: string | null;
  keyFull?: string | null;
  transcriptionModel?: string | null;
  postProcessingModel?: string | null;
  openRouterConfig?: Nullable<OpenRouterConfig>;
  baseUrl?: string | null;
  azureRegion?: string | null;
  includeV1Path?: boolean | null;
};
