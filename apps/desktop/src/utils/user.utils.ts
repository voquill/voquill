import { invoke } from "@tauri-apps/api/core";
import {
  satisfiesCapabilityRequirement,
  selectBestAccuracyPath,
  type DictationCapabilityRequirement,
  type ProviderCapability,
} from "@voquill/dictation-core";
import {
  ApiKey,
  ApiKeyProvider,
  DictationPillVisibility,
  Nullable,
  User,
  UserPreferences,
} from "@voquill/types";
import { countWords, getRec } from "@voquill/utilities";
import type {
  AgentMode,
  PostProcessingMode,
  TranscriptionMode,
} from "../types/ai.types";
import dayjs from "dayjs";
import { detectLocale, matchSupportedLocale } from "../i18n";
import { DEFAULT_LOCALE, type Locale } from "../i18n/config";
import { createTranscriptionSession } from "../sessions";
import type { AppState } from "../state/app.state";
import { applyAiPreferences } from "./ai.utils";
import { registerUsers } from "./app.utils";
import {
  getAllowsChangePostProcessing,
  getAllowsChangeTranscription,
} from "./enterprise.utils";
import {
  AUTO_LANGUAGE,
  coerceToDictationLanguage,
  DictationLanguageCode,
  KEYBOARD_LAYOUT_LANGUAGE,
} from "./language.utils";
import { getEffectivePlan, getMemberExceedsLimitByState } from "./member.utils";

export const LOCAL_USER_ID = "local-user-id";

export const getIsLoggedIn = (state: AppState): boolean => {
  return !!state.auth;
};

export const getHasEmailProvider = (state: AppState): boolean => {
  const auth = state.auth;
  const providers = auth?.providers ?? [];
  return providers.includes("password");
};

export const getIsOnboarded = (state: AppState): boolean => {
  return Boolean(getMyUser(state)?.onboarded);
};

export const getIsDictationUnlocked = (state: AppState): boolean => {
  return getIsOnboarded(state) || state.onboarding.dictationOverrideEnabled;
};

export const getHasCloudAccess = (state: AppState): boolean => {
  const effectivePlan = getEffectivePlan(state);
  return effectivePlan !== "community";
};

const resolveMode = <T extends string>(
  state: AppState,
  mode: T | null,
  fallback: T,
): T => {
  return mode ?? (getHasCloudAccess(state) ? ("cloud" as T) : fallback);
};

export const getEffectiveTranscriptionMode = (
  state: AppState,
): TranscriptionMode => {
  return resolveMode(state, state.settings.aiTranscription.mode, "local");
};

export const getEffectivePostProcessingMode = (
  state: AppState,
): PostProcessingMode => {
  return resolveMode(state, state.settings.aiPostProcessing.mode, "none");
};

export const getEffectiveAgentMode = (state: AppState): AgentMode => {
  return resolveMode(state, state.settings.agentMode.mode, "none");
};

export const getMyCloudUserId = (state: AppState): Nullable<string> =>
  state.auth?.uid ?? null;

export const getMyEffectiveUserId = (state: AppState): string => {
  return state.auth?.uid ?? LOCAL_USER_ID;
};

export const getMyUser = (state: AppState): Nullable<User> => {
  return getRec(state.userById, getMyEffectiveUserId(state)) ?? null;
};

export const getMyPreferredLocale = (state: AppState): Locale => {
  const user = getMyUser(state);
  return (
    matchSupportedLocale(user?.preferredLanguage) ??
    detectLocale() ??
    DEFAULT_LOCALE
  );
};

export const getDetectedSystemLocale = (): string => {
  return detectLocale() ?? DEFAULT_LOCALE;
};

export const getMyPrimaryDictationLanguage = (state: AppState): string => {
  const user = getMyUser(state);
  if (user?.preferredLanguage) {
    return user.preferredLanguage;
  }
  return getDetectedSystemLocale();
};

export const getMyDictationLanguage = (state: AppState): string => {
  // TODO: We should pass the dictation language into the processors instead of overriding
  const override = state.dictationLanguageOverride;
  if (override) {
    return override;
  }

  return getMyPrimaryDictationLanguage(state);
};

export const loadMyEffectiveDictationLanguage = async (
  state: AppState,
): Promise<DictationLanguageCode> => {
  let lang = getMyDictationLanguage(state);
  if (lang === AUTO_LANGUAGE) {
    return AUTO_LANGUAGE;
  }
  if (lang === KEYBOARD_LAYOUT_LANGUAGE) {
    lang = await invoke<string>("get_keyboard_language").catch((e) => {
      console.error("Failed to get keyboard language:", e);
      return "en";
    });
  }

  return coerceToDictationLanguage(lang);
};

export const formatDictationLanguageCode = (language: string): string => {
  if (language === AUTO_LANGUAGE) {
    return "AUTO";
  }
  const baseCode = language.split("-")[0];
  return baseCode.toUpperCase().slice(0, 2);
};

export const getMyUserPreferences = (
  state: AppState,
): Nullable<UserPreferences> => {
  return state.userPrefs;
};

export const getMyPreferredMicrophone = (state: AppState): Nullable<string> => {
  return state.userPrefs?.preferredMicrophone ?? null;
};

export const getShouldGoToOnboarding = (state: AppState): boolean => {
  const prefs = getMyUserPreferences(state);
  const gotStartedAt = prefs?.gotStartedAt;
  if (!gotStartedAt) {
    return false;
  }

  const now = Date.now();
  const elapsed = now - gotStartedAt;
  const twoMinutes = 2 * 60 * 1000;
  if (elapsed < twoMinutes) {
    return true;
  }

  return false;
};

export const getMyUserName = (state: AppState): string => {
  const user = getMyUser(state);
  return user?.name || "Guest";
};

export const getIsSignedIn = (state: AppState): boolean => {
  return !!state.auth;
};

export const setCurrentUser = (draft: AppState, user: User): void => {
  registerUsers(draft, [user]);
};

export const setUserPreferences = (
  draft: AppState,
  value: UserPreferences,
): void => {
  draft.userPrefs = value;
  applyAiPreferences(draft, value);
};

type BaseTranscriptionPrefs = {
  warnings: string[];
};

export type CloudTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "cloud";
};

export type LocalTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "local";
  gpuEnumerationEnabled: boolean;
  transcriptionDevice: string | null;
  transcriptionModelSize: string | null;
};

export type ApiTranscriptionPrefs = BaseTranscriptionPrefs & {
  mode: "api";
  provider: ApiKeyProvider;
  apiKeyId: string;
  apiKeyValue: string;
  transcriptionModel: string | null;
};

export type TranscriptionPrefs =
  | CloudTranscriptionPrefs
  | LocalTranscriptionPrefs
  | ApiTranscriptionPrefs;

type PlannedDesktopTranscriptionSelection = {
  apiKeyId: string;
  provider: ApiKeyProvider;
  model: string | null;
};

type DesktopTranscriptionCapability = ProviderCapability & {
  apiKeyId: string;
};

const NO_KEY_REQUIRED_PROVIDERS: ApiKeyProvider[] = [
  "speaches",
  "ollama",
  "openai-compatible",
];

const TRANSCRIPTION_PROVIDER_CAPABILITIES: Partial<
  Record<
    ApiKeyProvider | "cloud" | "local",
    Omit<ProviderCapability, "provider" | "model">
  >
> = {
  assemblyai: {
    supportsStreaming: true,
    supportsPrompt: false,
    priority: 60,
  },
  azure: {
    supportsStreaming: true,
    supportsPrompt: false,
    priority: 50,
  },
  deepgram: {
    supportsStreaming: true,
    supportsPrompt: true,
    priority: 100,
  },
  elevenlabs: {
    supportsStreaming: true,
    supportsPrompt: false,
    priority: 70,
  },
  aldea: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 55,
  },
  gemini: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 65,
  },
  groq: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 65,
  },
  openai: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 65,
  },
  "openai-compatible": {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 60,
  },
  speaches: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 60,
  },
  xai: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 60,
  },
  cloud: {
    supportsStreaming: true,
    supportsPrompt: false,
    priority: 80,
  },
  local: {
    supportsStreaming: false,
    supportsPrompt: true,
    priority: 40,
  },
};

const canUseApiKeyForTranscription = (apiKey: ApiKey): boolean =>
  !!apiKey.keyFull || NO_KEY_REQUIRED_PROVIDERS.includes(apiKey.provider);

const getDesktopTranscriptionCapabilityForApiKey = (
  apiKey: ApiKey,
): DesktopTranscriptionCapability | null => {
  const capability = TRANSCRIPTION_PROVIDER_CAPABILITIES[apiKey.provider];
  if (!capability || !canUseApiKeyForTranscription(apiKey)) {
    return null;
  }

  return {
    apiKeyId: apiKey.id,
    provider: apiKey.provider,
    model: apiKey.transcriptionModel ?? undefined,
    ...capability,
  };
};

export const getDesktopDictationCapabilityRequirement = (
  state: AppState,
): DictationCapabilityRequirement =>
  state.local.accurateDictationEnabled
    ? { streaming: true, prompt: true }
    : { streaming: true };

export const getTranscriptionProviderCapability = (
  prefs: TranscriptionPrefs,
): ProviderCapability | null => {
  if (prefs.mode === "api") {
    const capability = TRANSCRIPTION_PROVIDER_CAPABILITIES[prefs.provider];
    if (!capability) {
      return null;
    }

    return {
      provider: prefs.provider,
      model: prefs.transcriptionModel ?? undefined,
      ...capability,
    };
  }

  if (prefs.mode === "cloud") {
    return {
      provider: "cloud",
      ...TRANSCRIPTION_PROVIDER_CAPABILITIES.cloud!,
    };
  }

  return {
    provider: "local",
    model: prefs.transcriptionModelSize ?? undefined,
    ...TRANSCRIPTION_PROVIDER_CAPABILITIES.local!,
  };
};

export const planDesktopTranscriptionSelection = (
  state: AppState,
): PlannedDesktopTranscriptionSelection | null => {
  if (getEffectiveTranscriptionMode(state) !== "api") {
    return null;
  }

  const selectedApiKeyId = state.settings.aiTranscription.selectedApiKeyId;
  const selectedApiKey = getRec(state.apiKeyById, selectedApiKeyId);
  if (!selectedApiKey) {
    return null;
  }

  const fallbackSelection: PlannedDesktopTranscriptionSelection = {
    apiKeyId: selectedApiKey.id,
    provider: selectedApiKey.provider,
    model: selectedApiKey.transcriptionModel ?? null,
  };

  if (!state.local.accurateDictationEnabled) {
    return fallbackSelection;
  }

  const requiredCapabilities = getDesktopDictationCapabilityRequirement(state);
  const selectedCapability =
    getDesktopTranscriptionCapabilityForApiKey(selectedApiKey);
  if (
    selectedCapability &&
    satisfiesCapabilityRequirement(selectedCapability, requiredCapabilities)
  ) {
    return fallbackSelection;
  }

  const candidates = Object.values(state.apiKeyById)
    .map((apiKey) => getDesktopTranscriptionCapabilityForApiKey(apiKey))
    .filter((candidate): candidate is DesktopTranscriptionCapability =>
      Boolean(candidate),
    );

  try {
    const bestMatch = selectBestAccuracyPath({
      required: requiredCapabilities,
      candidates,
    }) as DesktopTranscriptionCapability;

    return {
      apiKeyId: bestMatch.apiKeyId,
      provider: bestMatch.provider as ApiKeyProvider,
      model: bestMatch.model ?? null,
    };
  } catch {
    return fallbackSelection;
  }
};

export const getTranscriptionPrefs = (state: AppState): TranscriptionPrefs => {
  const config = state.settings.aiTranscription;
  const mode = getEffectiveTranscriptionMode(state);
  const cloudAvailable = getHasCloudAccess(state);
  const exceedsLimits = getMemberExceedsLimitByState(state);
  const warnings: string[] = [];
  const allowChange = getAllowsChangeTranscription(state);

  if (mode === "cloud" || !allowChange) {
    if (cloudAvailable) {
      if (exceedsLimits) {
        warnings.push("Cloud transcription limit exceeded.");
      } else {
        return { mode: "cloud", warnings };
      }
    } else {
      warnings.push(
        "Cloud transcription is not available. Please check your subscription.",
      );
    }
  }

  if (mode === "api") {
    const plannedSelection = planDesktopTranscriptionSelection(state);
    const selectedApiKey = getRec(
      state.apiKeyById,
      plannedSelection?.apiKeyId ?? config.selectedApiKeyId,
    );
    const provider = plannedSelection?.provider ?? selectedApiKey?.provider;
    const apiKey = selectedApiKey?.keyFull;
    const noKeyRequired = provider
      ? NO_KEY_REQUIRED_PROVIDERS.includes(provider)
      : false;

    // Return API mode even if key is missing - respect user's configured mode
    // Let transcription fail later with clear error instead of silently falling back to local
    if (!apiKey && !noKeyRequired) {
      warnings.push("No API key configured for API transcription.");
    }

    return {
      mode: "api",
      provider: provider ?? "groq",
      apiKeyId: selectedApiKey?.id ?? config.selectedApiKeyId!,
      apiKeyValue: apiKey ?? "",
      transcriptionModel:
        plannedSelection?.model ?? selectedApiKey?.transcriptionModel ?? null,
      warnings,
    };
  }

  return {
    mode: "local",
    warnings,
    gpuEnumerationEnabled: config.gpuEnumerationEnabled,
    transcriptionDevice: config.device ?? null,
    transcriptionModelSize: config.modelSize ?? null,
  };
};

export const getTranscriptionSupportsStreaming = (state: AppState): boolean => {
  const prefs = getTranscriptionPrefs(state);
  const session = createTranscriptionSession(prefs);
  return session.supportsStreaming();
};

type BaseGenerativePrefs = {
  warnings: string[];
};

export type CloudGenerativePrefs = BaseGenerativePrefs & {
  mode: "cloud";
};

export type ApiGenerativePrefs = BaseGenerativePrefs & {
  mode: "api";
  provider: ApiKeyProvider;
  apiKeyId: string;
  apiKeyValue: string;
  postProcessingModel: string | null;
};

export type NoneGenerativePrefs = BaseGenerativePrefs & {
  mode: "none";
};

export type GenerativePrefs =
  | CloudGenerativePrefs
  | ApiGenerativePrefs
  | NoneGenerativePrefs;

type GenerativeConfigInput = {
  mode: "none" | "api" | "cloud" | null;
  selectedApiKeyId: string | null;
};

const getGenPrefsInternal = ({
  state,
  config,
  context,
  allowChange,
}: {
  state: AppState;
  config: GenerativeConfigInput;
  context: string;
  allowChange: boolean;
}): GenerativePrefs => {
  const mode = resolveMode(state, config.mode, "none");
  const apiKey = getRec(state.apiKeyById, config.selectedApiKeyId)?.keyFull;
  const exceedsLimits = getMemberExceedsLimitByState(state);
  const cloudAvailable = getHasCloudAccess(state);
  const warnings: string[] = [];

  if (mode === "cloud" || !allowChange) {
    if (cloudAvailable) {
      if (exceedsLimits) {
        warnings.push(`Cloud ${context} limit exceeded.`);
      } else {
        return { mode: "cloud", warnings };
      }
    } else {
      warnings.push(
        `Cloud ${context} is not available. Please check your subscription.`,
      );
    }
  }

  if (mode === "api") {
    const selectedApiKey = getRec(state.apiKeyById, config.selectedApiKeyId);
    const provider = selectedApiKey?.provider;
    const noKeyRequired =
      provider === "ollama" || provider === "openai-compatible";
    if (apiKey || noKeyRequired) {
      return {
        mode: "api",
        provider: provider ?? "groq",
        apiKeyId: config.selectedApiKeyId!,
        apiKeyValue: apiKey ?? "",
        postProcessingModel: selectedApiKey?.postProcessingModel ?? null,
        warnings,
      };
    } else {
      warnings.push(`No API key configured for API ${context}.`);
    }
  }

  return { mode: "none", warnings };
};

export const getGenerativePrefs = (state: AppState): GenerativePrefs => {
  return getGenPrefsInternal({
    state,
    config: state.settings.aiPostProcessing,
    context: "post-processing",
    allowChange: getAllowsChangePostProcessing(state),
  });
};

export type OpenClawGenerativePrefs = {
  mode: "openclaw";
  gatewayUrl: string;
  token: string;
  warnings: string[];
};

export type AgentModePrefs = GenerativePrefs | OpenClawGenerativePrefs;

export const getAgentModePrefs = (state: AppState): AgentModePrefs => {
  const agentMode = state.settings.agentMode;

  return getGenPrefsInternal({
    state,
    config: agentMode as GenerativeConfigInput,
    context: "agent mode",
    allowChange: !state.isEnterprise,
  });
};

export const getEffectiveStreak = (state: AppState): number => {
  const user = getMyUser(state);
  const streak = user?.streak;
  const recordedAt = user?.streakRecordedAt;
  if (!streak || !recordedAt) {
    return 0;
  }

  const today = dayjs().format("YYYY-MM-DD");
  if (recordedAt === today) {
    return streak;
  }

  const yesterday = dayjs().subtract(1, "day").format("YYYY-MM-DD");
  if (recordedAt === yesterday) {
    return streak;
  }

  return 0;
};

export const getEffectivePillVisibility = (
  visibility?: Nullable<string>,
): DictationPillVisibility => {
  if (
    visibility === "hidden" ||
    visibility === "while_active" ||
    visibility === "persistent"
  ) {
    return visibility;
  }

  return "persistent";
};

const SILENCE_PADDING_MS = 1500;
const MIN_DURATION_FOR_PADDING_MS = 4000;

export type DictationSpeed = {
  wpm: number;
  sampleCount: number;
};

export const getDictationSpeed = (state: AppState): DictationSpeed | null => {
  const ids = state.transcriptions.transcriptionIds;
  let totalWpm = 0;
  let count = 0;

  for (const id of ids) {
    const t = getRec(state.transcriptionById, id);
    if (
      !t ||
      !t.audio?.durationMs ||
      t.audio.durationMs <= 0 ||
      !t.transcript
    ) {
      continue;
    }
    const words = countWords(t.transcript);
    if (words <= 0) continue;
    let durationMs = t.audio.durationMs;
    if (durationMs >= MIN_DURATION_FOR_PADDING_MS) {
      durationMs -= SILENCE_PADDING_MS;
    }
    totalWpm += words / (durationMs / 60000);
    count++;
  }

  if (count === 0) return null;
  return { wpm: Math.round(totalWpm / count), sampleCount: count };
};

export const getUsingCloudPrefs = (state: AppState): boolean => {
  const transcriptionPrefs = getTranscriptionPrefs(state);
  const generativePrefs = getGenerativePrefs(state);
  const agentModePrefs = getAgentModePrefs(state);
  return (
    transcriptionPrefs.mode === "cloud" ||
    generativePrefs.mode === "cloud" ||
    agentModePrefs.mode === "cloud"
  );
};
