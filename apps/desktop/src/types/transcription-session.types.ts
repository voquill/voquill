import {
  PostProcessMetadata,
  TranscribeAudioMetadata,
} from "../actions/transcribe.actions";

export type StopRecordingResponse = {
  samples: number[] | Float32Array;
  sampleRate?: number;
};

export type TranscriptionSessionResult = {
  rawTranscript: string | null;
  processedTranscript?: string | null;
  metadata: TranscribeAudioMetadata;
  postProcessMetadata?: PostProcessMetadata;
  warnings: string[];
  /**
   * Set when the transcript does not cover the whole recording (stream failed
   * to open, dropped, errored or timed out). Sessions set it to request
   * recovery; after recovery it means the audio could not be transcribed.
   */
  failureReason?: string | null;
  /** True when the transcript came from re-transcribing the recorded audio. */
  recovered?: boolean;
};

export type TranscriptionSessionFinalizeOptions = {
  toneId?: string | null;
  a11yInfo?: unknown;
};

export type InterimResultCallback = (segment: string) => void;

export interface TranscriptionSession {
  /** Stable provider name for logs (class names are mangled when minified). */
  readonly name: string;
  onRecordingStart(sampleRate: number): Promise<void>;
  finalize(
    audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult>;
  cleanup(): void;
  supportsStreaming(): boolean;
  setInterimResultCallback(callback: InterimResultCallback): void;
}
