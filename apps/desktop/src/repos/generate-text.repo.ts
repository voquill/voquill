import { invokeHandler, type CloudModel } from "@voquill/functions";
import type {
  JsonResponse,
  LlmChatInput,
  LlmStreamEvent,
  Nullable,
  OpenRouterProviderRouting,
} from "@voquill/types";
import {
  azureOpenAIGenerateText,
  azureOpenaiStreamChat,
  claudeGenerateTextResponse,
  claudeStreamChat,
  ClaudeModel,
  cerebrasGenerateTextResponse,
  cerebrasStreamChat,
  CerebrasModel,
  deepseekGenerateTextResponse,
  deepseekStreamChat,
  DeepseekModel,
  GeminiGenerateTextModel,
  geminiGenerateTextResponse,
  geminiStreamChat,
  GenerateTextModel,
  groqGenerateTextResponse,
  groqStreamChat,
  OpenAIGenerateTextModel,
  openaiGenerateTextResponse,
  openaiStreamChat,
  OPENROUTER_DEFAULT_MODEL,
  openrouterGenerateTextResponse,
  openrouterStreamChat,
} from "@voquill/voice-ai";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { PostProcessingMode } from "../types/ai.types";
import {
  invokeEnterprise,
  invokeEnterpriseStream,
} from "../utils/enterprise.utils";
import { invokeHandlerStream } from "../utils/firebase.utils";
import { BaseRepo } from "./base.repo";

export type GenerateTextInput = {
  system?: Nullable<string>;
  prompt: string;
  jsonResponse?: JsonResponse;
};

export type GenerateTextMetadata = {
  postProcessingMode?: Nullable<PostProcessingMode>;
  inferenceDevice?: Nullable<string>;
};

export type GenerateTextOutput = {
  text: string;
  metadata?: GenerateTextMetadata;
};

export abstract class BaseGenerateTextRepo extends BaseRepo {
  abstract generateText(input: GenerateTextInput): Promise<GenerateTextOutput>;
  abstract streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent>;
}

export class CloudGenerateTextRepo extends BaseGenerateTextRepo {
  private model: CloudModel;

  constructor(model: CloudModel = "medium") {
    super();
    this.model = model;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await invokeHandler("ai/generateText", {
      system: input.system,
      prompt: input.prompt,
      jsonResponse: input.jsonResponse,
      model: this.model,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "cloud",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* invokeHandlerStream("ai/streamChat", {
      ...input,
      model: this.model,
    });
  }
}

export class GroqGenerateTextRepo extends BaseGenerateTextRepo {
  private groqApiKey: string;
  private model: GenerateTextModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.groqApiKey = apiKey;
    this.model =
      (model as GenerateTextModel) ??
      "meta-llama/llama-4-scout-17b-16e-instruct";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await groqGenerateTextResponse({
      apiKey: this.groqApiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Groq",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* groqStreamChat({
      apiKey: this.groqApiKey,
      model: this.model,
      input,
    });
  }
}

export class OpenAIGenerateTextRepo extends BaseGenerateTextRepo {
  private openaiApiKey: string;
  private model: OpenAIGenerateTextModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.openaiApiKey = apiKey;
    this.model = (model as OpenAIGenerateTextModel) ?? "gpt-4o-mini";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      apiKey: this.openaiApiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenAI",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.openaiApiKey,
      model: this.model,
      input,
    });
  }
}

export class OllamaGenerateTextRepo extends BaseGenerateTextRepo {
  private ollamaUrl: string;
  private model: string;
  private apiKey: string;

  constructor(url: string, model: string, apiKey?: string) {
    super();
    this.ollamaUrl = url;
    this.model = model;
    this.apiKey = apiKey || "ollama";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      baseUrl: this.ollamaUrl,
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      customFetch: tauriFetch,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Ollama",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.apiKey,
      baseUrl: this.ollamaUrl,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class OpenAICompatibleGenerateTextRepo extends BaseGenerateTextRepo {
  private baseUrl: string;
  private model: string;
  private apiKey: string;

  constructor(url: string, model: string, apiKey?: string) {
    super();
    this.baseUrl = url;
    this.model = model;
    this.apiKey = apiKey || "";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openaiGenerateTextResponse({
      baseUrl: this.baseUrl,
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      customFetch: tauriFetch,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenAI Compatible",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openaiStreamChat({
      apiKey: this.apiKey,
      baseUrl: this.baseUrl,
      model: this.model,
      input,
      customFetch: tauriFetch,
    });
  }
}

export class OpenRouterGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: string;
  private providerRouting?: OpenRouterProviderRouting;

  constructor(
    apiKey: string,
    model: string | null,
    providerRouting?: OpenRouterProviderRouting,
  ) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? OPENROUTER_DEFAULT_MODEL;
    this.providerRouting = providerRouting;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await openrouterGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
      providerRouting: this.providerRouting,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • OpenRouter",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* openrouterStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class AzureOpenAIGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private endpoint: string;
  private deploymentName: string;

  constructor(apiKey: string, endpoint: string, deploymentName: string | null) {
    super();
    this.apiKey = apiKey;
    this.endpoint = endpoint;
    this.deploymentName = deploymentName ?? "gpt-4o-mini";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await azureOpenAIGenerateText({
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      deploymentName: this.deploymentName,
      system: input.system ?? undefined,
      prompt: input.prompt,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Azure OpenAI",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* azureOpenaiStreamChat({
      apiKey: this.apiKey,
      endpoint: this.endpoint,
      deploymentName: this.deploymentName,
      input,
    });
  }
}

export class DeepseekGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: DeepseekModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as DeepseekModel) ?? "deepseek-v4-flash";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await deepseekGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • DeepSeek",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* deepseekStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class GeminiGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: GeminiGenerateTextModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as GeminiGenerateTextModel) ?? "gemini-2.5-flash";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await geminiGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Gemini",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* geminiStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class ClaudeGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: ClaudeModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as ClaudeModel) ?? "claude-sonnet-4-20250514";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await claudeGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Claude",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* claudeStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class CerebrasGenerateTextRepo extends BaseGenerateTextRepo {
  private apiKey: string;
  private model: CerebrasModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as CerebrasModel) ?? "zai-glm-4.7";
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await cerebrasGenerateTextResponse({
      apiKey: this.apiKey,
      model: this.model,
      prompt: input.prompt,
      system: input.system ?? undefined,
      jsonResponse: input.jsonResponse,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "api",
        inferenceDevice: "API • Cerebras",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* cerebrasStreamChat({
      apiKey: this.apiKey,
      model: this.model,
      input,
    });
  }
}

export class EnterpriseGenerateTextRepo extends BaseGenerateTextRepo {
  private model: CloudModel;

  constructor(model: CloudModel = "medium") {
    super();
    this.model = model;
  }

  async generateText(input: GenerateTextInput): Promise<GenerateTextOutput> {
    const response = await invokeEnterprise("ai/generateText", {
      system: input.system,
      prompt: input.prompt,
      jsonResponse: input.jsonResponse,
      model: this.model,
    });

    return {
      text: response.text,
      metadata: {
        postProcessingMode: "cloud",
      },
    };
  }

  async *streamChat(input: LlmChatInput): AsyncGenerator<LlmStreamEvent> {
    yield* invokeEnterpriseStream("ai/streamChat", {
      ...input,
      model: this.model,
    });
  }
}
