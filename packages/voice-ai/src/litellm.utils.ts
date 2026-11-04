import type { CustomFetch } from "./types";

export const LITELLM_DEFAULT_URL = "http://localhost:4000";

const GENERATIVE_MODES = new Set(["chat", "completion", "responses"]);
const TRANSCRIPTION_MODE = "audio_transcription";

export type LiteLLMModels = {
  generative: string[];
  transcription: string[];
};

type LiteLLMModelInfoEntry = {
  model_name?: string;
  model_info?: { mode?: string | null } | null;
};

export const buildLiteLLMApiUrl = (baseUrl?: string | null): string => {
  const normalized = (baseUrl?.trim() || LITELLM_DEFAULT_URL).replace(
    /\/+$/,
    "",
  );
  return normalized.endsWith("/v1") ? normalized : `${normalized}/v1`;
};

const buildProxyRootUrl = (baseUrl?: string | null): string =>
  buildLiteLLMApiUrl(baseUrl).replace(/\/v1$/, "");

const buildHeaders = (apiKey?: string): Record<string, string> => {
  const key = apiKey?.trim();
  return key ? { Authorization: `Bearer ${key}` } : {};
};

const sortedUnique = (names: Iterable<string>): string[] =>
  [...new Set(names)].sort();

// /model/info carries each alias's mode, so transcription and post-processing
// aliases land in the right picker whatever they are named. Keys without access
// to /model/info fall back to /v1/models, which has no mode.
export const litellmFetchModels = async ({
  baseUrl,
  apiKey,
  customFetch = globalThis.fetch,
}: {
  baseUrl?: string | null;
  apiKey?: string;
  customFetch?: CustomFetch;
}): Promise<LiteLLMModels> => {
  const headers = buildHeaders(apiKey);

  const infoResponse = await customFetch(
    `${buildProxyRootUrl(baseUrl)}/model/info`,
    { headers },
  ).catch(() => null);
  if (infoResponse?.ok) {
    const payload = (await infoResponse.json()) as {
      data?: LiteLLMModelInfoEntry[];
    };
    const generative: string[] = [];
    const transcription: string[] = [];
    for (const entry of payload.data ?? []) {
      const name = entry.model_name?.trim();
      if (!name || name.includes("*")) continue;
      const mode = entry.model_info?.mode ?? "chat";
      if (mode === TRANSCRIPTION_MODE) {
        transcription.push(name);
      } else if (GENERATIVE_MODES.has(mode)) {
        generative.push(name);
      }
    }
    return {
      generative: sortedUnique(generative),
      transcription: sortedUnique(transcription),
    };
  }

  const listResponse = await customFetch(
    `${buildLiteLLMApiUrl(baseUrl)}/models`,
    { headers },
  ).catch(() => null);
  if (!listResponse?.ok) {
    return { generative: [], transcription: [] };
  }
  const payload = (await listResponse.json()) as {
    data?: Array<{ id?: string }>;
  };
  const names = sortedUnique(
    (payload.data ?? [])
      .map((model) => model.id?.trim() ?? "")
      .filter((name) => name && !name.includes("*")),
  );
  return { generative: names, transcription: names };
};

export type LiteLLMTestIntegrationArgs = {
  baseUrl?: string | null;
  apiKey?: string;
  customFetch?: CustomFetch;
};

export const litellmTestIntegration = async ({
  baseUrl,
  apiKey,
  customFetch = globalThis.fetch,
}: LiteLLMTestIntegrationArgs): Promise<boolean> => {
  const url = `${buildLiteLLMApiUrl(baseUrl)}/models`;
  let response: Response;
  try {
    response = await customFetch(url, { headers: buildHeaders(apiKey) });
  } catch (error) {
    throw new Error(
      `Could not reach the LiteLLM proxy at ${buildProxyRootUrl(baseUrl)}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      "The LiteLLM proxy rejected the API key. Use a LiteLLM virtual key or the proxy master key.",
    );
  }
  if (!response.ok) {
    throw new Error(
      `LiteLLM proxy error: ${response.status} ${response.statusText}`,
    );
  }
  return true;
};
