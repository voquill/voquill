import type {
  AppTarget,
  DictationContextTarget,
  Nullable,
} from "@voquill/types";
import type {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";
import type { TextFieldInfo } from "./accessibility.types";
import type { ToastAction } from "./toast.types";
import type { StopRecordingResponse } from "./transcription-session.types";

export type StrategyValidationError = {
  title: string;
  body: string;
  action: Nullable<ToastAction>;
};

export type HandleTranscriptParams = {
  rawTranscript: string;
  processedTranscript?: string | null;
  serverPostProcessMetadata?: PostProcessMetadata;
  toneId: string | null;
  a11yInfo: TextFieldInfo | null;
  currentApp: AppTarget | null;
  currentEditor?: DictationContextTarget | null;
  selectedText?: string | null;
  screenContext?: string | null;
  clipboardContext?: string | null;
  loadingToken: symbol | null;
  audio: StopRecordingResponse;
  transcriptionMetadata: TranscribeAudioMetadata;
  transcriptionWarnings: string[];
};

export type HandleTranscriptResult = {
  shouldContinue: boolean;
  transcript: string | null;
  sanitizedTranscript: string | null;
  postProcessMetadata: PostProcessMetadata;
  postProcessWarnings: string[];
  remoteStatus?: "sent" | "received" | null;
  remoteDeviceId?: string | null;
};
