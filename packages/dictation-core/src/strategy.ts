import {
  createProviderCapabilityRegistry,
  type DictationCapabilityRequirement,
  type ProviderCapability,
} from "./capabilities";

export type SelectBestAccuracyPathInput = {
  required: DictationCapabilityRequirement;
  candidates: ProviderCapability[];
};

export const selectBestAccuracyPath = ({
  required,
  candidates,
}: SelectBestAccuracyPathInput): ProviderCapability => {
  const registry = createProviderCapabilityRegistry(candidates);
  const matches = registry.filter(required).sort(
    (left, right) => (right.priority ?? 0) - (left.priority ?? 0),
  );

  if (matches.length === 0) {
    throw new Error("No provider satisfies the required dictation capabilities");
  }

  return matches[0];
};
