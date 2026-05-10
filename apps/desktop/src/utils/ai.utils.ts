import type { LlmMessage, UserPreferences } from "@voquill/types";
import { AppState } from "../state/app.state";
import { CPU_DEVICE_VALUE, DEFAULT_MODEL_SIZE } from "../types/ai.types";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "./local-transcription.utils";

export const unwrapNestedLlmResponse = <T extends Record<string, unknown>>(
  parsed: T,
  key: string & keyof T,
): T => {
  const value = parsed[key];
  if (
    value &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    key in value &&
    typeof (value as Record<string, unknown>)[key] === "string"
  ) {
    return { ...parsed, [key]: (value as Record<string, unknown>)[key] } as T;
  }
  return parsed;
};

export const parseStructuredJsonResponse = <TKey extends string>(
  text: string,
  key: TKey,
): Record<TKey, unknown> => {
  const extractedJson = extractJsonFromMarkdown(text);
  const parsed = JSON.parse(extractedJson) as Record<TKey, unknown>;
  return unwrapNestedLlmResponse(parsed, key);
};

/**
 * When an LLM returns plain text instead of the expected JSON envelope, extract
 * the text from common patterns rather than discarding the output entirely.
 * Returns null when the raw output appears to be malformed JSON with no useful text.
 */
export const recoverPlainTextFromLLMResponse = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) return null;

  // If it doesn't look like JSON at all, treat the whole thing as the transcript.
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) {
    // Strip any <SYSTEM_INSTRUCTIONS>…</SYSTEM_INSTRUCTIONS> leakage
    const stripped = trimmed
      .replace(/<SYSTEM_INSTRUCTIONS>[\s\S]*?<\/SYSTEM_INSTRUCTIONS>/g, "")
      .trim();
    return stripped || null;
  }

  // Try extracting a "result" field without a full JSON parse
  const match = trimmed.match(/"result"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  if (match) {
    return match[1].replace(/\\n/g, "\n").replace(/\\"/g, '"').trim();
  }

  return null;
};

export const extractJsonFromMarkdown = (text: string): string => {
  // Try to extract JSON from markdown code blocks
  const jsonBlockMatch = text.match(/```(?:json)?\s*\n?([\s\S]*?)\n?```/);
  if (jsonBlockMatch) {
    return jsonBlockMatch[1].trim();
  }

  // Try to extract JSON from inline code blocks (only if content looks like JSON)
  const inlineJsonMatch = text.match(/`([^`]+)`/g);
  if (inlineJsonMatch) {
    for (const match of inlineJsonMatch) {
      const content = match.slice(1, -1).trim();
      if (content.startsWith("{") || content.startsWith("[")) {
        return content;
      }
    }
  }

  // Return original text if no markdown formatting found
  return text.trim();
};

export const applyAiPreferences = (
  draft: AppState,
  preferences: UserPreferences,
): void => {
  draft.settings.aiTranscription.mode = preferences.transcriptionMode ?? null;
  draft.settings.aiTranscription.selectedApiKeyId =
    preferences.transcriptionApiKeyId ?? null;
  const normalizedDevice = normalizeTranscriptionDevice(
    preferences.transcriptionDevice ?? CPU_DEVICE_VALUE,
  );
  draft.settings.aiTranscription.device = normalizedDevice;
  draft.settings.aiTranscription.modelSize =
    preferences.transcriptionModelSize ?? DEFAULT_MODEL_SIZE;
  draft.settings.aiTranscription.gpuEnumerationEnabled =
    supportsGpuTranscriptionDevice() &&
    (preferences.gpuEnumerationEnabled ??
      isGpuPreferredTranscriptionDevice(normalizedDevice));

  draft.settings.aiPostProcessing.mode = preferences.postProcessingMode ?? null;
  draft.settings.aiPostProcessing.selectedApiKeyId =
    preferences.postProcessingApiKeyId ?? null;

  draft.settings.agentMode.mode = preferences.agentMode ?? null;
  draft.settings.agentMode.selectedApiKeyId =
    preferences.agentModeApiKeyId ?? null;
  draft.settings.agentMode.openclawGatewayUrl =
    preferences.openclawGatewayUrl ?? null;
  draft.settings.agentMode.openclawToken = preferences.openclawToken ?? null;
};

export function formatMessagesAsPrompt(messages: LlmMessage[]): {
  system: string | undefined;
  prompt: string;
} {
  const systemMsg = messages.find((m) => m.role === "system");
  const nonSystemMessages = messages.filter((m) => m.role !== "system");

  if (nonSystemMessages.length <= 1) {
    const lastMsg = nonSystemMessages[0];
    return {
      system: systemMsg?.content,
      prompt:
        lastMsg?.role === "user"
          ? lastMsg.content
          : lastMsg?.role === "assistant"
            ? (lastMsg.content ?? "")
            : "",
    };
  }

  const formatted = nonSystemMessages
    .map((m) => {
      if (m.role === "user") return `User: ${m.content}`;
      if (m.role === "assistant") return `Assistant: ${m.content ?? ""}`;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");

  return {
    system: systemMsg?.content,
    prompt: formatted,
  };
}
