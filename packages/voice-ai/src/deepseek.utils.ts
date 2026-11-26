import OpenAI from "openai";
import {
  ChatCompletionContentPart,
  ChatCompletionMessageParam,
} from "openai/resources/chat/completions";
import { retry, countWords } from "@voquill/utilities";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
} from "@voquill/types";
import { openaiCompatibleStreamChat } from "./openai.utils";

export const DEEPSEEK_MODELS = [
  "deepseek-v4-flash",
  "deepseek-v4-pro",
] as const;
export type DeepseekModel = (typeof DEEPSEEK_MODELS)[number];

const DEEPSEEK_BASE_URL = "https://api.deepseek.com";

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
  return new OpenAI({
    apiKey: apiKey.trim(),
    baseURL: DEEPSEEK_BASE_URL,
    dangerouslyAllowBrowser: true, // This is safe because Voquill natively on desktop
  });
};

export type DeepseekGenerateTextArgs = {
  apiKey: string;
  model?: string;
  system?: string;
  prompt: string;
  jsonResponse?: JsonResponse;
};

export type DeepseekGenerateResponseOutput = {
  text: string;
  tokensUsed: number;
};

export const deepseekGenerateTextResponse = async ({
  apiKey,
  model = "deepseek-v4-flash",
  system,
  prompt,
  jsonResponse,
}: DeepseekGenerateTextArgs): Promise<DeepseekGenerateResponseOutput> => {
  return retry({
    retries: 3,
    fn: async () => {
      const client = createClient(apiKey);

      const messages: ChatCompletionMessageParam[] = [];
      if (system) {
        messages.push({ role: "system", content: system });
      }

      let finalPrompt = prompt;
      if (jsonResponse) {
        finalPrompt = `${prompt}\n\nRespond with valid JSON matching this schema: ${JSON.stringify(jsonResponse.schema)}`;
      }

      const userParts: ChatCompletionContentPart[] = [];
      userParts.push({ type: "text", text: finalPrompt });
      messages.push({ role: "user", content: userParts });

      const response = await client.chat.completions.create({
        messages,
        model,
        temperature: 1,
        max_tokens: 1024,
        top_p: 1,
        response_format: jsonResponse ? { type: "json_object" } : undefined,
      });

      console.log("deepseek llm usage:", response.usage);
      if (!response.choices || response.choices.length === 0) {
        throw new Error("No response from DeepSeek");
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

export type DeepseekTestIntegrationArgs = {
  apiKey: string;
};

export const deepseekTestIntegration = async ({
  apiKey,
}: DeepseekTestIntegrationArgs): Promise<boolean> => {
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
    model: "deepseek-v4-flash",
    temperature: 0,
    max_tokens: 32,
    top_p: 1,
  });

  if (!response.choices || response.choices.length === 0) {
    throw new Error("No response from DeepSeek");
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

export type DeepseekStreamChatArgs = {
  apiKey: string;
  model: string;
  input: LlmChatInput;
};

export async function* deepseekStreamChat({
  apiKey,
  model,
  input,
}: DeepseekStreamChatArgs): AsyncGenerator<LlmStreamEvent> {
  const client = createClient(apiKey);
  yield* openaiCompatibleStreamChat(client, model, input);
}
