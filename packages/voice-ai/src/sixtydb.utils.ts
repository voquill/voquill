import { countWords } from "@voquill/utilities";

export type SixtyDBTestIntegrationArgs = {
  apiKey: string;
};

const authorization = (apiKey: string): string => {
  if (!apiKey.trim()) throw new Error("60db workspace API key is required");
  return `Bearer ${apiKey.trim()}`;
};

export const sixtydbTestIntegration = async ({
  apiKey,
}: SixtyDBTestIntegrationArgs): Promise<boolean> => {
  const response = await fetch("https://api.60db.ai/voices", {
    headers: { Authorization: authorization(apiKey) },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) {
    throw new Error(`60db key check failed with status ${response.status}`);
  }
  return true;
};

export type SixtyDBTranscriptionArgs = {
  apiKey: string;
  blob: ArrayBuffer | Buffer;
  language?: string;
};

export const sixtydbTranscribeAudio = async ({
  apiKey,
  blob,
  language,
}: SixtyDBTranscriptionArgs): Promise<{ text: string; wordsUsed: number }> => {
  const auth = authorization(apiKey);
  const audio =
    blob instanceof ArrayBuffer ? new Uint8Array(blob) : Uint8Array.from(blob);
  if (!audio.byteLength || audio.byteLength > 10_000_000) {
    throw new Error("60db audio must be nonempty and at most 10 MB");
  }
  const form = new FormData();
  form.append("file", new Blob([audio], { type: "audio/wav" }), "audio.wav");
  const code = language?.trim().toLowerCase();
  if (code && code !== "auto") form.append("language", code.split("-")[0]!);

  const response = await fetch("https://api.60db.ai/stt", {
    method: "POST",
    headers: { Authorization: auth },
    body: form,
    redirect: "error",
    signal: AbortSignal.timeout(60_000),
  });
  if (!response.ok) {
    throw new Error(`60db transcription failed with status ${response.status}`);
  }
  const data: unknown = await response.json();
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    throw new Error("60db returned an invalid transcript response");
  }
  const result = data as Record<string, unknown>;
  if (
    result.success === false ||
    result.error ||
    result.error_code ||
    typeof result.text !== "string"
  ) {
    throw new Error("60db returned an invalid transcript response");
  }
  return { text: result.text, wordsUsed: countWords(result.text) };
};
