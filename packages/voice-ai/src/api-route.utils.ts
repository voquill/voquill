import type { CustomFetch } from "./types";

export const API_ROUTE_BASE_URL = "https://global.api-route.com/v1";
export const API_ROUTE_DEFAULT_MODEL = "deepseek-v4.1-flash";

export const apiRouteTestIntegration = async ({
  apiKey,
  customFetch = globalThis.fetch,
}: {
  apiKey: string;
  customFetch?: CustomFetch;
}): Promise<boolean> => {
  const response = await customFetch(`${API_ROUTE_BASE_URL}/models`, {
    headers: { Authorization: `Bearer ${apiKey.trim()}` },
  });
  if (!response.ok) {
    throw new Error(
      `API Route API error: ${response.status} ${response.statusText}`,
    );
  }
  return true;
};
