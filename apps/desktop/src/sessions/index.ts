import { satisfiesCapabilityRequirement } from "@voquill/dictation-core";
import { getRec } from "@voquill/utilities";
import { getAppState } from "../store";
import { TranscriptionSession } from "../types/transcription-session.types";
import { getIsEnterpriseEnabled } from "../utils/enterprise.utils";
import {
  getDesktopDictationCapabilityRequirement,
  getTranscriptionProviderCapability,
  TranscriptionPrefs,
} from "../utils/user.utils";
import { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
import { AzureTranscriptionSession } from "./azure-transcription-session";
import { BatchTranscriptionSession } from "./batch-transcription-session";
import { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
import { LocalTranscriptionSession } from "./local-transcription-session";
import { NewServerTranscriptionSession } from "./new-server-transcription-session";

export { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
export { AzureTranscriptionSession } from "./azure-transcription-session";
export { BatchTranscriptionSession } from "./batch-transcription-session";
export { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
export { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
export { LocalTranscriptionSession } from "./local-transcription-session";
export { NewServerTranscriptionSession } from "./new-server-transcription-session";

export const createTranscriptionSession = (
  prefs: TranscriptionPrefs,
): TranscriptionSession => {
  const state = getAppState();
  const requiredCapabilities = getDesktopDictationCapabilityRequirement(state);
  const providerCapability = getTranscriptionProviderCapability(prefs);
  const canUseRealtimePath =
    providerCapability &&
    satisfiesCapabilityRequirement(providerCapability, requiredCapabilities);

  if (prefs.mode === "api") {
    if (!canUseRealtimePath) {
      return new BatchTranscriptionSession();
    }

    switch (prefs.provider) {
      case "assemblyai":
        return new AssemblyAITranscriptionSession(prefs.apiKeyValue);
      case "deepgram":
        return new DeepgramTranscriptionSession(prefs.apiKeyValue);
      case "elevenlabs":
        return new ElevenLabsTranscriptionSession(prefs.apiKeyValue);
      case "azure": {
        const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
        const region = apiKeyRecord?.azureRegion || "eastus";
        return new AzureTranscriptionSession(prefs.apiKeyValue, region);
      }
    }
  }

  if (prefs.mode === "cloud" && !getIsEnterpriseEnabled() && canUseRealtimePath) {
    return new NewServerTranscriptionSession();
  }

  if (prefs.mode === "local") {
    return new LocalTranscriptionSession();
  }

  return new BatchTranscriptionSession();
};
