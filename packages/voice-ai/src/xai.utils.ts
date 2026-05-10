import { countWords, retry } from "@voquill/utilities";

const XAI_BASE_URL = "https://api.x.ai/v1";

export const XAI_TRANSCRIPTION_MODELS = ["grok-stt"] as const;
export type XaiTranscriptionModel = (typeof XAI_TRANSCRIPTION_MODELS)[number];

export const XAI_TTS_VOICES = ["eve", "ara", "rex", "sal", "leo"] as const;
export type XaiTtsVoice = (typeof XAI_TTS_VOICES)[number];

export type XaiTestIntegrationArgs = {
  apiKey: string;
};

export const xaiTestIntegration = async ({
  apiKey,
}: XaiTestIntegrationArgs): Promise<boolean> => {
  const response = await fetch(`${XAI_BASE_URL}/models`, {
    method: "GET",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
    },
  });

  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(
      detail
        ? `xAI responded ${response.status}: ${detail}`
        : `xAI responded with status ${response.status}`,
    );
  }
  return true;
};

export type XaiTranscriptionArgs = {
  apiKey: string;
  model?: XaiTranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type XaiTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const xaiTranscribeAudio = async ({
  apiKey,
  model = "grok-stt",
  blob,
  ext,
  prompt,
  language,
}: XaiTranscriptionArgs): Promise<XaiTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const formData = new FormData();
      const bodyData =
        blob instanceof ArrayBuffer ? blob : (blob.buffer as ArrayBuffer);
      const audioBlob = new Blob([bodyData], { type: `audio/${ext}` });
      formData.append("file", audioBlob, `audio.${ext}`);
      formData.append("model", model);
      formData.append("format", "json");
      if (prompt) {
        formData.append("prompt", prompt);
      }
      if (language && language !== "auto") {
        formData.append("language", language);
      }

      const response = await fetch(`${XAI_BASE_URL}/stt`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey.trim()}`,
        },
        body: formData,
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => "Unknown error");
        throw new Error(
          `xAI STT request failed with status ${response.status}: ${errorText}`,
        );
      }

      const data = (await response.json()) as { text?: string };
      const transcript = data?.text;

      if (!transcript) {
        throw new Error("Transcription failed: No text in xAI STT response");
      }

      return { text: transcript, wordsUsed: countWords(transcript) };
    },
  });
};

export type XaiSpeakArgs = {
  apiKey: string;
  text: string;
  voice?: XaiTtsVoice;
  language?: string;
};

export const xaiGenerateSpeech = async ({
  apiKey,
  text,
  voice = "eve",
  language = "en",
}: XaiSpeakArgs): Promise<ArrayBuffer> => {
  const response = await fetch(`${XAI_BASE_URL}/tts`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey.trim()}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      text,
      voice_id: voice,
      language,
    }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `xAI TTS request failed with status ${response.status}: ${errorText}`,
    );
  }

  return response.arrayBuffer();
};
