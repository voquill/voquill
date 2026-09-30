import OpenAI, { toFile } from "openai";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { retry, countWords } from "@voquill/utilities";
import type { JsonResponse, LlmChatInput, LlmStreamEvent } from "@voquill/types";
import { openaiCompatibleStreamChat } from "./openai.utils";

export const INFERENCEAPIS_GENERATE_TEXT_MODELS = [
  "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "zai-org/GLM-5.3-Flash",
  "openai/gpt-oss-120b",
] as const;
export type InferenceApisGenerateTextModel =
  (typeof INFERENCEAPIS_GENERATE_TEXT_MODELS)[number];

// Reasoning models need `reasoning_effort: "none"` for low-latency cleanup,
// or they think for seconds before responding.
const REASONING_MODELS = new Set<string>([
  "deepseek-ai/DeepSeek-V4.1-Flash",
  "zai-org/GLM-5.3-Flash",
  "openai/gpt-oss-120b",
]);

export const INFERENCEAPIS_TRANSCRIPTION_MODELS = [
  "openai/whisper-large-v3",
  "nvidia/parakeet-tdt-0.6b-v3",
  "mistralai/Voxtral-Mini-3B-2507",
  "mistralai/Voxtral-Small-24B-2507",
] as const;
export type InferenceApisTranscriptionModel =
  (typeof INFERENCEAPIS_TRANSCRIPTION_MODELS)[number];

const INFERENCEAPIS_BASE_URL = "https://api.inferenceapis.com/v1";

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
  // The Tauri app doesn't run in a web browser and encrypts API keys locally, so this
  // is safe.
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: INFERENCEAPIS_BASE_URL,
    dangerouslyAllowBrowser: true,
  });
};

export type InferenceApisTranscriptionArgs = {
  apiKey: string;
  model?: InferenceApisTranscriptionModel;
  blob: ArrayBuffer | Buffer;
  ext: string;
  prompt?: string;
  language?: string;
};

export type InferenceApisTranscribeAudioOutput = {
  text: string;
  wordsUsed: number;
};

export const inferenceApisTranscribeAudio = async ({
  apiKey,
  model = "openai/whisper-large-v3",
  blob,
  ext,
  prompt,
  language,
}: InferenceApisTranscriptionArgs): Promise<InferenceApisTranscribeAudioOutput> => {
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

export type InferenceApisGenerateTextArgs = {
  apiKey: string;
  model?: InferenceApisGenerateTextModel;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
};

export type InferenceApisGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const inferenceApisGenerateTextResponse = async ({
  apiKey,
  model = "meta-llama/Llama-3.3-70B-Instruct-Turbo",
  system,
  prompt,
  jsonResponse,
}: InferenceApisGenerateTextArgs): Promise<InferenceApisGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }

      const userParts: ChatCompletionContentPart[] = [];
      userParts.push({ type: "text", text: prompt });
      messages.push({ role: "user", content: userParts });

      const params: Record<string, unknown> = {
        messages,
        model,
        temperature: 1,
        max_tokens: 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      };
      if (REASONING_MODELS.has(model)) {
        params.reasoning_effort = "none";
      }

      const response = await client.chat.completions.create(
        params as unknown as OpenAI.ChatCompletionCreateParamsNonStreaming,
      );

      console.log("inferenceapis llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from Inference APIs");
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

export type InferenceApisTestIntegrationArgs = {
  apiKey: string;
};

export const inferenceApisTestIntegration = async ({
  apiKey,
}: InferenceApisTestIntegrationArgs): Promise<boolean> => {
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
    model: "meta-llama/Llama-3.3-70B-Instruct-Turbo",
    temperature: 0,
    max_tokens: 32,
    top_p: 1,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No response from Inference APIs");
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

export type InferenceApisStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
};

export async function* inferenceApisStreamChat({
  apiKey,
  model,
  input,
}: InferenceApisStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey);
  yield* openaiCompatibleStreamChat(
    client,
    model,
    input,
    REASONING_MODELS.has(model) ? { reasoning_effort: "none" } : undefined,
  );
}
