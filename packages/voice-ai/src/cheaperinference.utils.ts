import type { CustomFetch } from "./types";

export const CHEAPER_INFERENCE_BASE_URL = "https://api.cheaperinference.com/v1";

export const CHEAPER_INFERENCE_MODELS = [
  "gpt-5.4-mini",
  "gpt-5.4",
  "claude-sonnet-5",
  "deepseek-v4-flash",
  "glm-5.3",
] as const;
export type CheaperInferenceModel = (typeof CHEAPER_INFERENCE_MODELS)[number];

export const CHEAPER_INFERENCE_DEFAULT_MODEL: CheaperInferenceModel =
  "gpt-5.4-mini";

export type CheaperInferenceTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const cheaperinferenceTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: CheaperInferenceTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${CHEAPER_INFERENCE_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!response.ok) {
    throw new Error(
      `Cheaper Inference API error: ${response.status} ${response.statusText}`,
    );
  }

  return true;
};
