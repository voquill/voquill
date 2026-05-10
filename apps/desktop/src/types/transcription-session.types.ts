import type { DictationContextTarget, DictationIntent } from "@voquill/types";
import {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";

export type StopRecordingResponse = {
  filePath: string;
  sampleRate: number;
  sampleCount: number;
};

export type TranscriptionSessionResult = {
  rawTranscript: string | null;
  processedTranscript?: string | null;
  authoritativeTranscript?: string | null;
  isAuthoritative?: boolean | null;
  isFinalized?: boolean | null;
  dictationIntent?: DictationIntent | null;
  metadata: TranscribeAudioMetadata;
  postProcessMetadata?: PostProcessMetadata;
  warnings: string[];
};

export type TranscriptionSessionFinalizeOptions = {
  toneId?: string | null;
  a11yInfo?: unknown;
  currentApp?: DictationContextTarget | null;
  currentEditor?: DictationContextTarget | null;
  selectedText?: string | null;
  screenContext?: string | null;
};

export type InterimResultCallback = (segment: string) => void;

export interface TranscriptionSession {
  onRecordingStart(sampleRate: number): Promise<void>;
  finalize(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult>;
  cleanup(): void;
  supportsStreaming(): boolean;
  setInterimResultCallback(callback: InterimResultCallback): void;
}
