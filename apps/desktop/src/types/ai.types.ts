import type {
  AgentMode,
  PostProcessingMode,
  TranscriptionMode,
} from "@repo/types";

export type { AgentMode, PostProcessingMode, TranscriptionMode };

export const DEFAULT_TRANSCRIPTION_MODE: TranscriptionMode = "local";
export const DEFAULT_MODEL_SIZE = "base";
export const CPU_DEVICE_VALUE = "cpu";
export const DEFAULT_POST_PROCESSING_MODE: PostProcessingMode = "none";
export const DEFAULT_AGENT_MODE: AgentMode = "none";
