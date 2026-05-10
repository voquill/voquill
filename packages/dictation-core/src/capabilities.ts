import type {
  DictationCapabilityRequirement as SharedDictationCapabilityRequirement,
  DictationProviderCapability as SharedDictationProviderCapability,
} from "@voquill/types";

export type DictationCapabilityRequirement =
  SharedDictationCapabilityRequirement;

export type ProviderCapability = SharedDictationProviderCapability;

export type ProviderCapabilityRegistry = {
  list(): ProviderCapability[];
  get(provider: string, model?: string): ProviderCapability | undefined;
  filter(required: DictationCapabilityRequirement): ProviderCapability[];
};

const toRegistryKey = (provider: string, model?: string): string =>
  `${provider.toLowerCase()}::${(model ?? "").toLowerCase()}`;

export const satisfiesCapabilityRequirement = (
  capability: ProviderCapability,
  required: DictationCapabilityRequirement,
): boolean => {
  if (required.streaming && !capability.supportsStreaming) {
    return false;
  }

  if (required.prompt && !capability.supportsPrompt) {
    return false;
  }

  return true;
};

export const createProviderCapabilityRegistry = (
  capabilities: ProviderCapability[],
): ProviderCapabilityRegistry => {
  const capabilityByKey = new Map<string, ProviderCapability>();

  for (const capability of capabilities) {
    capabilityByKey.set(
      toRegistryKey(capability.provider, capability.model),
      capability,
    );
  }

  return {
    list: () => [...capabilityByKey.values()],
    get: (provider, model) => {
      const exactMatch = capabilityByKey.get(toRegistryKey(provider, model));
      if (exactMatch) {
        return exactMatch;
      }

      if (!model) {
        const normalizedProvider = provider.toLowerCase();
        return [...capabilityByKey.values()].find(
          (candidate) => candidate.provider.toLowerCase() === normalizedProvider,
        );
      }

      return undefined;
    },
    filter: (required) =>
      [...capabilityByKey.values()].filter((candidate) =>
        satisfiesCapabilityRequirement(candidate, required),
      ),
  };
};
