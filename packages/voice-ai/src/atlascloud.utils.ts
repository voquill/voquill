import type { CustomFetch } from "./types";

export const ATLAS_CLOUD_BASE_URL = "https://api.atlascloud.ai/v1";

export const ATLAS_CLOUD_MODELS = [
  "deepseek-ai/deepseek-v4-flash",
  "moonshotai/kimi-k3",
  "zai-org/glm-5.2",
  "qwen/qwen3.5-397b-a17b",
] as const;
export type AtlasCloudModel = (typeof ATLAS_CLOUD_MODELS)[number];

export const ATLAS_CLOUD_DEFAULT_MODEL: AtlasCloudModel =
  "deepseek-ai/deepseek-v4-flash";

export type AtlasCloudTestIntegrationArgs = {
  apiKey: string;
  customFetch?: CustomFetch;
};

export const atlascloudTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: AtlasCloudTestIntegrationArgs): Promise<boolean> => {
  const response = await customFetch(`${ATLAS_CLOUD_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });

  if (!response.ok) {
    throw new Error(
      `Atlas Cloud API error: ${response.status} ${response.statusText}`,
    );
  }

  return true;
};
