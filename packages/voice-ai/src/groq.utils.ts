import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@voquill/types";
import { countWords, retry } from "@voquill/utilities";
import Groq, { toFile } from "groq-sdk/index";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "groq-sdk/resources/chat/completions";
import OpenAI from "openai";
import { openaiCompatibleStreamChat } from "./openai.utils";

export const GENERATE_TEXT_MODELS = [
  "moonshotai/kimi-k2-instruct-0905",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
] as const;
export type GenerateTextModel = (typeof GENERATE_TEXT_MODELS)[number];

// Models that support `response_format: { type: "json_schema" }`.
// See https://console.groq.com/docs/structured-outputs
const JSON_SCHEMA_SUPPORTED_MODELS = new Set<string>([
  "moonshotai/kimi-k2-instruct-0905",
  "openai/gpt-oss-20b",
  "openai/gpt-oss-120b",
]);

export const TRANSCRIPTION_MODELS = ["whisper-large-v3-turbo"] as const;
export type TranscriptionModel = (typeof TRANSCRIPTION_MODELS)[number];

const contentToString = (
  content: string | ChatCompletionContentPart[] | null | undefined,
): string => {
  if (!content) {
    return "";
  }

  if (typeof content === "string") {
    return content;
  }

  return content
    .map((part) => {
      if (part.type === "text") {
        return part.text ?? "";
      }
      return "";
    })
    .join("")
    .trim();
};

const createClient = (apiKey: string) => {
  // `dangerouslyAllowBrowser` is needed because this runs on a desktop tauri app.
  // The Tauri app doesn't run in a web browser and encyrpts API keys locally, so this
  // is safe.
  return new Groq({ apiKey: apiKey.trim(), dangerouslyAllowBrowser: true });
};

export type GroqTranscriptionArgs = {
  apiKey: string;
  model?: TranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type GroqTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const groqTranscribeAudio = async ({
  apiKey,
  model = "whisper-large-v3-turbo",
  blob,
  ext,
  prompt,
  language,
}: GroqTranscriptionArgs): Promise<GroqTranscribeAudioOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const file = await toFile(blob, `audio.${ext}`);
      const response = await client.audio.transcriptions.create({
        file,
        model,
        prompt,
        language: language && language !== "auto" ? language : undefined,
      });

      if (!response.text) {
        throw new Error("Transcription failed");
      }

      return { text: response.text, wordsUsed: countWords(response.text) };
    },
  });
};

export type GroqGenerateTextArgs = {
  apiKey: string;
  model?: GenerateTextModel;
  system?: string;
  prompt: string;
  imageUrls?: string[];
  jsonResponse?: JsonResponse;
};

export type GroqGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const groqGenerateTextResponse = async ({
  apiKey,
  model = "openai/gpt-oss-120b",
  system,
  prompt,
  imageUrls = [],
  jsonResponse,
}: GroqGenerateTextArgs): Promise<GroqGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }

      const userParts: ChatCompletionContentPart[] = [];
      for (const url of imageUrls) {
        userParts.push({
          type: "image_url",
          image_url: { url },
        });
      }

      userParts.push({ type: "text", text: prompt });
      messages.push({ role: "user", content: userParts });

      const response = await client.chat.completions.create({
        messages,
        model,
        max_completion_tokens: 5000,
        response_format: jsonResponse
          ? JSON_SCHEMA_SUPPORTED_MODELS.has(model)
            ? {
                type: "json_schema",
                json_schema: {
                  name: jsonResponse.name,
                  description: jsonResponse.description,
                  schema: jsonResponse.schema,
                },
              }
            : { type: "json_object" }
          : undefined,
      });

      console.log("groq llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from Groq");
      }

      const result = response.choices[0].message.content;
      if (!result) {
        throw new Error("Content is empty");
      }

      const content = contentToString(result);
      return {
        text: content,
        tokensUsed: response.usage?.total_tokens ?? countWords(content),
      };
    },
  });
};

export type GroqTestIntegrationArgs = {
  apiKey: string;
};

export const groqTestIntegration = async ({
  apiKey,
}: GroqTestIntegrationArgs): Promise<boolean> => {
  const client = createClient(apiKey);

  const response = await client.chat.completions.create({
    messages: [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: `Reply with the single word "Hello."`,
          },
        ],
      },
    ],
    model: "openai/gpt-oss-120b",
    temperature: 0,
    reasoning_effort: "low",
    max_completion_tokens: 1024,
    top_p: 1,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No response from Groq");
  }

  const first = response.choices[0];
  const content = contentToString(first?.message?.content);
  if (!content) {
    throw new Error("Response content is empty");
  }

  return content.toLowerCase().includes("hello");
};

// ============================================================================
// Streaming Chat
// ============================================================================

export type GroqStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
};

export async function* groqStreamChat({
  apiKey,
  model,
  input,
}: GroqStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: "https://api.groq.com/openai/v1",
    dangerouslyAllowBrowser: true,
  });
  yield* openaiCompatibleStreamChat(client, model, input);
}
