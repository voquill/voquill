import type { CustomFetch } from "./types";

export const UBERLLM_BASE_URL = "https://api.uberllm.dev/v1";

export const UBERLLM_MODELS = [
  "openai/gpt-5.4-mini",
  "openai/gpt-5.4",
  "anthropic/claude-sonnet-5",
  "deepseek/deepseek-v4-flash",
  "z-ai/glm-5.3",
] as const;
export type UberLLMModel = (typeof UBERLLM_MODELS)[number];

export const UBERLLM_DEFAULT_MODEL: UberLLMModel = "openai/gpt-5.4-mini";

export type UberLLMTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const uberllmTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: UberLLMTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${UBERLLM_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!response.ok) {
    throw new Error(
      `UberLLM API error: ${response.status} ${response.statusText}`,
    );
  }

  return true;
};
