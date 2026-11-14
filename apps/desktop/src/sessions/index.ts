import { getRec } from "@voquill/utilities";
import { getAppState } from "../store";
import { TranscriptionSession } from "../types/transcription-session.types";
import { getIsEnterpriseEnabled } from "../utils/enterprise.utils";
import { transcribeAudio } from "../actions/transcribe.actions";
import { getHostedTranscriptionTimeoutMs } from "../utils/transcribe.utils";
import { TranscriptionPrefs } from "../utils/user.utils";
import { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
import { AzureTranscriptionSession } from "./azure-transcription-session";
import { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
import { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
import { LocalTranscriptionSession } from "./local-transcription-session";
import { NewServerTranscriptionSession } from "./new-server-transcription-session";
import { RecoverableTranscriptionSession } from "./recoverable-transcription-session";

export { AssemblyAITranscriptionSession } from "./assemblyai-transcription-session";
export { AzureTranscriptionSession } from "./azure-transcription-session";
export { DeepgramTranscriptionSession } from "./deepgram-transcription-session";
export { ElevenLabsTranscriptionSession } from "./elevenlabs-transcription-session";
export { LocalTranscriptionSession } from "./local-transcription-session";
export { NewServerTranscriptionSession } from "./new-server-transcription-session";
export { RecoverableTranscriptionSession } from "./recoverable-transcription-session";

/** Null for modes that transcribe the recording in one shot after it stops. */
const createStreamingTranscriptionSession = (
  prefs: TranscriptionPrefs,
): TranscriptionSession | null => {
  if (prefs.mode === "api") {
    switch (prefs.provider) {
      case "assemblyai":
        return new AssemblyAITranscriptionSession(prefs.apiKeyValue);
      case "deepgram":
        return new DeepgramTranscriptionSession(prefs.apiKeyValue);
      case "elevenlabs":
        return new ElevenLabsTranscriptionSession(prefs.apiKeyValue);
      case "azure": {
        const state = getAppState();
        const apiKeyRecord = getRec(state.apiKeyById, prefs.apiKeyId);
        const region = apiKeyRecord?.azureRegion || "eastus";
        return new AzureTranscriptionSession(prefs.apiKeyValue, region);
      }
    }
  }

  if (
    prefs.mode === "cloud" &&
    !getIsEnterpriseEnabled() &&
    !getAppState().local.accurateDictationEnabled
  ) {
    return new NewServerTranscriptionSession();
  }

  if (prefs.mode === "local") {
    return new LocalTranscriptionSession();
  }

  return null;
};

const SELF_HOSTED_TRANSCRIPTION_PROVIDERS = new Set([
  "speaches",
  "openai-compatible",
]);

/**
 * A total-time cap is only safe for hosted providers reached over plain fetch.
 * Local and self-hosted inference can legitimately be slow, and the New Server
 * transcribe-raw socket bounds itself by upload progress and processing time.
 */
export const getTranscriptionAttemptTimeout = (
  prefs: TranscriptionPrefs,
): ((audioDurationMs: number) => number) | null => {
  if (prefs.mode === "local") {
    return null;
  }
  if (
    prefs.mode === "api" &&
    SELF_HOSTED_TRANSCRIPTION_PROVIDERS.has(prefs.provider)
  ) {
    return null;
  }
  if (prefs.mode === "cloud" && !getIsEnterpriseEnabled()) {
    return null;
  }
  return getHostedTranscriptionTimeoutMs;
};

/**
 * Captures the transcription preferences when recording starts, so a settings
 * change mid-dictation cannot switch where this recording's audio is sent.
 */
export const createTranscriptionSession = (
  prefs: TranscriptionPrefs,
): RecoverableTranscriptionSession =>
  new RecoverableTranscriptionSession(
    createStreamingTranscriptionSession(prefs),
    {
      transcribe: (input) =>
        transcribeAudio({ ...input, transcriptionPrefs: prefs }),
      getAttemptTimeoutMs: getTranscriptionAttemptTimeout(prefs),
    },
  );
