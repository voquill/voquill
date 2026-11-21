import type { CustomFetch } from "./types";

export const OPENLLM_BASE_URL = "https://www.openllm.sh/v1";

export const OPENLLM_MODELS = ["lite", "plus", "ultra"] as const;
export type OpenLLMModel = (typeof OPENLLM_MODELS)[number];

export const OPENLLM_DEFAULT_MODEL: OpenLLMModel = "lite";

export type OpenLLMTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const openllmTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: OpenLLMTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${OPENLLM_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!response.ok) {
    throw new Error(
      `OpenLLM API error: ${response.status} ${response.statusText}`,
    );
  }

  return true;
};
