import type {
  DictationPostProcessingPolicy as SharedPostProcessingPolicy,
  DictationPostProcessingPolicyMode as SharedPostProcessingPolicyMode,
} from "@voquill/types";

export type PostProcessingPolicyMode = SharedPostProcessingPolicyMode;

export type PostProcessingPolicy = SharedPostProcessingPolicy;

export type CreatePostProcessingPolicyInput = {
  mode?: PostProcessingPolicyMode;
  allowLlmCleanup?: boolean;
};

export const createPostProcessingPolicy = ({
  mode = "rules",
  allowLlmCleanup = false,
}: CreatePostProcessingPolicyInput = {}): PostProcessingPolicy => {
  const resolvedMode = mode === "llm" && !allowLlmCleanup ? "rules" : mode;

  return {
    mode: resolvedMode,
    preserveReplacements: true,
    requiresStructuredOutput: resolvedMode === "llm",
  };
};
