import type { ReactNode } from "react";
import type { ApiKeyProvider } from "@voquill/types";
import {
  aldeaTestIntegration,
  assemblyaiTestIntegration,
  azureOpenAITestIntegration,
  azureTestIntegration,
  cerebrasTestIntegration,
  claudeTestIntegration,
  deepgramTestIntegration,
  deepseekTestIntegration,
  elevenlabsTestIntegration,
  geminiTestIntegration,
  groqTestIntegration,
  inferenceApisTestIntegration,
  openaiCompatibleTestIntegration,
  openaiTestIntegration,
  openrouterTestIntegration,
  xaiTestIntegration,
} from "@voquill/voice-ai";
import { FormattedMessage } from "react-intl";
import type { SettingsApiKey } from "../../state/settings.state";
import {
  OLLAMA_DEFAULT_URL,
  ollamaTestIntegration,
} from "../../utils/ollama.utils";
import { OPENAI_COMPATIBLE_DEFAULT_URL } from "../../utils/openai-compatible.utils";
import { speachesTestIntegration } from "../../utils/speaches.utils";
import type { ApiKeyListContext } from "./ApiKeyList";

export type ProviderFieldDescriptor = {
  key: string;
  label: ReactNode;
  placeholder: string;
  helperText?: ReactNode;
  type?: "password" | "text";
  required: boolean;
};

export type ProviderFormConfig = {
  displayName: string;
  fields: ProviderFieldDescriptor[];
  showIncludeV1Path?: boolean;
  defaultBaseUrl?: string;
  testIntegration: (
    apiKey: SettingsApiKey,
    context: ApiKeyListContext,
  ) => Promise<boolean>;
};

const API_KEY_FIELD: ProviderFieldDescriptor = {
  key: "apiKey",
  label: <FormattedMessage defaultMessage="API key" />,
  placeholder: "Paste your API key",
  type: "password",
  required: true,
};

const OPTIONAL_API_KEY_FIELD: ProviderFieldDescriptor = {
  ...API_KEY_FIELD,
  label: <FormattedMessage defaultMessage="API key (optional)" />,
  placeholder: "Leave empty if not required",
  helperText: (
    <FormattedMessage defaultMessage="Only needed if your instance requires authentication" />
  ),
  required: false,
};

function requireApiKey(apiKey: SettingsApiKey): string {
  if (!apiKey.keyFull) {
    throw new Error("The stored API key value is unavailable.");
  }
  return apiKey.keyFull;
}

function standardTestConfig(
  testFn: (args: { apiKey: string }) => Promise<boolean>,
): ProviderFormConfig["testIntegration"] {
  return (apiKey) => testFn({ apiKey: requireApiKey(apiKey) });
}

const STANDARD_PROVIDERS: Record<
  string,
  {
    displayName: string;
    testFn: (args: { apiKey: string }) => Promise<boolean>;
  }
> = {
  groq: { displayName: "Groq", testFn: groqTestIntegration },
  openai: { displayName: "OpenAI", testFn: openaiTestIntegration },
  openrouter: { displayName: "OpenRouter", testFn: openrouterTestIntegration },
  aldea: { displayName: "Aldea", testFn: aldeaTestIntegration },
  assemblyai: { displayName: "AssemblyAI", testFn: assemblyaiTestIntegration },
  deepgram: { displayName: "Deepgram", testFn: deepgramTestIntegration },
  elevenlabs: { displayName: "ElevenLabs", testFn: elevenlabsTestIntegration },
  deepseek: { displayName: "DeepSeek", testFn: deepseekTestIntegration },
  gemini: { displayName: "Gemini", testFn: geminiTestIntegration },
  claude: { displayName: "Claude", testFn: claudeTestIntegration },
  cerebras: { displayName: "Cerebras", testFn: cerebrasTestIntegration },
  xai: { displayName: "xAI Grok", testFn: xaiTestIntegration },
  inferenceapis: {
    displayName: "Inference APIs",
    testFn: inferenceApisTestIntegration,
  },
};

function buildStandardConfig(provider: string): ProviderFormConfig {
  const entry = STANDARD_PROVIDERS[provider]!;
  return {
    displayName: entry.displayName,
    fields: [API_KEY_FIELD],
    testIntegration: standardTestConfig(entry.testFn),
  };
}

const OLLAMA_CONFIG: ProviderFormConfig = {
  displayName: "Ollama",
  defaultBaseUrl: OLLAMA_DEFAULT_URL,
  fields: [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Base URL" />,
      placeholder: OLLAMA_DEFAULT_URL,
      helperText: (
        <FormattedMessage defaultMessage="Leave empty to use the default URL" />
      ),
      required: false,
    },
    OPTIONAL_API_KEY_FIELD,
  ],
  testIntegration: (apiKey) =>
    ollamaTestIntegration({
      baseUrl: apiKey.baseUrl || OLLAMA_DEFAULT_URL,
      apiKey: apiKey.keyFull || undefined,
    }),
};

function getOpenAICompatibleConfig(
  context: ApiKeyListContext,
): ProviderFormConfig {
  const fields: ProviderFieldDescriptor[] = [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Base URL" />,
      placeholder: OPENAI_COMPATIBLE_DEFAULT_URL,
      helperText: (
        <FormattedMessage defaultMessage="Leave empty to use the default URL" />
      ),
      required: false,
    },
    OPTIONAL_API_KEY_FIELD,
  ];
  if (context === "transcription") {
    fields.push({
      key: "transcriptionModel",
      label: <FormattedMessage defaultMessage="Model" />,
      placeholder: "whisper-1",
      helperText: (
        <FormattedMessage defaultMessage="Transcription model name (e.g. whisper-1, gpt-4o-transcribe)" />
      ),
      required: false,
    });
  }
  return {
    displayName: "OpenAI Compatible",
    defaultBaseUrl: OPENAI_COMPATIBLE_DEFAULT_URL,
    showIncludeV1Path: true,
    fields,
    testIntegration: (apiKey) =>
      openaiCompatibleTestIntegration({
        baseUrl: apiKey.baseUrl || OPENAI_COMPATIBLE_DEFAULT_URL,
        apiKey: apiKey.keyFull || undefined,
      }),
  };
}

const SPEACHES_CONFIG: ProviderFormConfig = {
  displayName: "Speaches",
  defaultBaseUrl: "http://localhost:8000",
  fields: [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Speaches URL" />,
      placeholder: "http://localhost:8000",
      helperText: (
        <FormattedMessage defaultMessage="URL of your local Speaches Docker instance" />
      ),
      required: false,
    },
    {
      key: "transcriptionModel",
      label: <FormattedMessage defaultMessage="Model" />,
      placeholder: "Systran/faster-whisper-large-v3",
      helperText: (
        <FormattedMessage defaultMessage="Whisper model ID available in your Speaches instance" />
      ),
      required: false,
    },
  ],
  testIntegration: (apiKey) =>
    speachesTestIntegration({
      baseUrl: apiKey.baseUrl || "http://localhost:8000",
    }),
};

const AZURE_OPENAI_CONFIG: ProviderFormConfig = {
  displayName: "Azure OpenAI",
  fields: [
    {
      key: "baseUrl",
      label: <FormattedMessage defaultMessage="Azure OpenAI Endpoint" />,
      placeholder: "https://my-resource.openai.azure.com",
      helperText: (
        <FormattedMessage defaultMessage="Your Azure OpenAI resource endpoint URL" />
      ),
      required: true,
    },
    {
      ...API_KEY_FIELD,
      placeholder: "Paste your Azure OpenAI API key",
    },
  ],
  testIntegration: (apiKey) => {
    const key = requireApiKey(apiKey);
    if (!apiKey.baseUrl) {
      throw new Error("Azure OpenAI endpoint is required.");
    }
    return azureOpenAITestIntegration({
      apiKey: key,
      endpoint: apiKey.baseUrl,
    });
  },
};

const AZURE_STT_CONFIG: ProviderFormConfig = {
  displayName: "Azure",
  fields: [
    {
      key: "azureRegion",
      label: <FormattedMessage defaultMessage="Azure Region" />,
      placeholder: "e.g., eastus, westus, northeurope",
      helperText: (
        <FormattedMessage defaultMessage="Azure service region for Speech-to-Text" />
      ),
      required: true,
    },
    {
      ...API_KEY_FIELD,
      label: <FormattedMessage defaultMessage="Subscription Key" />,
      placeholder: "Paste your Azure subscription key",
    },
  ],
  testIntegration: (apiKey) => {
    const key = requireApiKey(apiKey);
    if (!apiKey.azureRegion) {
      throw new Error("Azure region is required.");
    }
    return azureTestIntegration({
      subscriptionKey: key,
      region: apiKey.azureRegion,
    });
  },
};

export function getProviderFormConfig(
  provider: ApiKeyProvider,
  context: ApiKeyListContext,
): ProviderFormConfig {
  if (provider === "azure") {
    return context === "transcription" ? AZURE_STT_CONFIG : AZURE_OPENAI_CONFIG;
  }
  if (provider === "ollama") return OLLAMA_CONFIG;
  if (provider === "openai-compatible")
    return getOpenAICompatibleConfig(context);
  if (provider === "speaches") return SPEACHES_CONFIG;
  return buildStandardConfig(provider);
}
