import { PostProcessingMode, TranscriptionMode } from "./common.types";

export type DictationIntent =
  | {
      kind: "dictation";
      format: "verbatim" | "clean";
    }
  | {
      kind: "command";
      action?: string;
    };

export type DictationContextTarget = {
  id: string;
  name: string;
};

export type DictationContextTerm = {
  sourceValue: string;
  destinationValue: string;
  isReplacement: boolean;
};

export type DictationContext = {
  intent: DictationIntent;
  language: string;
  glossaryTerms: string[];
  replacementMap: Record<string, string>;
  currentApp: DictationContextTarget | null;
  currentEditor: DictationContextTarget | null;
  selectedText: string | null;
  screenContext: string | null;
  clipboardContext: string | null;
};

export type SharedTermPayload = Pick<
  DictationContextTerm,
  "sourceValue" | "destinationValue" | "isReplacement"
>;

export const toSharedTermPayload = (
  term: SharedTermPayload,
): SharedTermPayload => ({
  sourceValue: term.sourceValue,
  destinationValue: term.destinationValue,
  isReplacement: term.isReplacement,
});

export const DEFAULT_DICTATION_INTENT: DictationIntent = {
  kind: "dictation",
  format: "clean",
};

export type DictationTranscriptEvent = {
  text: string;
  authoritativeText: string;
  isAuthoritative: boolean;
  isFinal: boolean;
  intent: DictationIntent;
};

export type DictationTranscriptEventInput = {
  text: string;
  authoritativeText?: string;
  isAuthoritative?: boolean;
  isFinal?: boolean;
  intent?: DictationIntent;
};

export const toDictationTranscriptEvent = ({
  text,
  authoritativeText = text,
  isAuthoritative = false,
  isFinal = false,
  intent = DEFAULT_DICTATION_INTENT,
}: DictationTranscriptEventInput): DictationTranscriptEvent => ({
  text,
  authoritativeText,
  isAuthoritative,
  isFinal,
  intent,
});

export type DictationCapabilityRequirement = {
  streaming?: boolean;
  prompt?: boolean;
};

export type DictationProviderCapability = {
  provider: string;
  model?: string;
  supportsStreaming: boolean;
  supportsPrompt: boolean;
  priority?: number;
};

export type DictationTranscriptUpdate = {
  text: string;
  isAuthoritative?: boolean;
  isFinal?: boolean;
  intent?: DictationIntent;
};

export type DictationTranscriptReconcilerSnapshot = {
  partialText: string;
  finalText: string | null;
  authoritativeText: string;
  isAuthoritative: boolean;
  isFinal: boolean;
};

export type StoredTranscriptionContract = {
  text: string;
  rawTranscript: string;
  authoritativeTranscript: string;
  isAuthoritative: boolean;
  isFinalized: boolean;
  dictationIntent: DictationIntent | null;
};

export type StoredTranscriptionContractInput = {
  text: string;
  rawTranscript: string;
  authoritativeTranscript?: string;
  isAuthoritative?: boolean;
  isFinalized?: boolean;
  dictationIntent?: DictationIntent | null;
};

export const toStoredTranscriptionContract = ({
  text,
  rawTranscript,
  authoritativeTranscript = rawTranscript,
  isAuthoritative = true,
  isFinalized = true,
  dictationIntent = DEFAULT_DICTATION_INTENT,
}: StoredTranscriptionContractInput): StoredTranscriptionContract => ({
  text,
  rawTranscript,
  authoritativeTranscript,
  isAuthoritative,
  isFinalized,
  dictationIntent,
});

export type DictationPostProcessingPolicyMode = "none" | "rules" | "llm";

export type DictationPostProcessingPolicy = {
  mode: DictationPostProcessingPolicyMode;
  preserveReplacements: boolean;
  requiresStructuredOutput: boolean;
};

export type Transcription = {
  id: string;
  createdAt: string;
  createdByUserId: string;
  transcript: string;
  isDeleted: boolean;
  audio?: TranscriptionAudioSnapshot;
  modelSize?: string | null;
  inferenceDevice?: string | null;
  rawTranscript?: string | null;
  authoritativeTranscript?: string | null;
  isAuthoritative?: boolean | null;
  isFinalized?: boolean | null;
  dictationIntent?: DictationIntent | null;
  sanitizedTranscript?: string | null;
  transcriptionPrompt?: string | null;
  postProcessPrompt?: string | null;
  transcriptionApiKeyId?: string | null;
  postProcessApiKeyId?: string | null;
  transcriptionMode?: TranscriptionMode | null;
  postProcessMode?: PostProcessingMode | null;
  postProcessDevice?: string | null;
  transcriptionDurationMs?: number | null;
  postprocessDurationMs?: number | null;
  warnings?: string[] | null;
  remoteStatus?: "sent" | "received" | null;
  remoteDeviceId?: string | null;
};

export type TranscriptionAudioSnapshot = {
  filePath: string;
  durationMs: number;
};
