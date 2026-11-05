import type { CustomFetch } from "./types";

export const CHEAPAIMODEL_BASE_URL = "https://api.cheapaimodel.ai/v1";

export const CHEAPAIMODEL_MODELS = [
  "deepseek-v4-1-flash",
  "grok-4.7",
] as const;
export type CheapaimodelModel = (typeof CHEAPAIMODEL_MODELS)[number];

export const CHEAPAIMODEL_DEFAULT_MODEL: CheapaimodelModel =
  "deepseek-v4-1-flash";

export type CheapaimodelTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const cheapaimodelTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: CheapaimodelTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${CHEAPAIMODEL_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!response.ok) {
    throw new Error(
      `cheapaimodel API error: ${response.status} ${response.statusText}`,
    );
  }

  return true;
};
