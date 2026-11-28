import type { CustomFetch } from "./types";

export const MARTLLM_BASE_URL = "https://api.martllm.com/v1";

export const MARTLLM_MODELS = [
  "deepseek/deepseek-v4-flash",
  "google/gemini-3.1-flash-lite",
  "anthropic/claude-haiku-5.5",
  "anthropic/claude-sonnet-5",
  "z-ai/glm-5.3",
] as const;
export type MartLLMModel = (typeof MARTLLM_MODELS)[number];

export const MARTLLM_DEFAULT_MODEL: MartLLMModel = "deepseek/deepseek-v4-flash";

export type MartLLMTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const martllmTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: MartLLMTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${MARTLLM_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!response.ok) {
    throw new Error(
      `MartLLM API error: ${response.status} ${response.statusText}`,
    );
  }

  return true;
};
