import { getAppState } from "../store";
import { TranscriptionSessionResult } from "../types/transcription-session.types";
import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import {
  type LocalSidecarStreamingSession,
  getLocalTranscriptionSidecarManager,
} from "../sidecars";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { mapDictationLanguageToWhisperLanguage } from "../utils/language.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { PushStreamTranscriptionSession } from "./push-stream-transcription-session";

export class LocalTranscriptionSession extends PushStreamTranscriptionSession<LocalSidecarStreamingSession> {
  readonly name = "Local";
  protected readonly metadata = { transcriptionMode: "local" } as const;
  protected readonly connectTimeoutMs = null;
  private prompt: string | null = null;

  protected async createStream(
    sampleRate: number,
  ): Promise<LocalSidecarStreamingSession> {
    const state = getAppState();
    const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
    const prompt = buildLocalizedTranscriptionPrompt({
      entries: collectDictionaryEntries(state),
      dictationLanguage,
      state,
    });
    this.prompt = prompt;

    const settings = state.settings.aiTranscription;
    return await getLocalTranscriptionSidecarManager().createStreamingSession({
      model: normalizeLocalWhisperModel(settings.modelSize),
      preferGpu: isGpuPreferredTranscriptionDevice(settings.device),
      sampleRate,
      language: mapDictationLanguageToWhisperLanguage(dictationLanguage),
      initialPrompt: prompt || undefined,
      deviceId: getTranscriptionSidecarDeviceId(settings.device),
    });
  }

  protected async finishStream(
    stream: LocalSidecarStreamingSession,
  ): Promise<TranscriptionSessionResult> {
    const output = await stream.finalize();
    return {
      rawTranscript: output.text.trim() || null,
      metadata: {
        modelSize: output.model,
        inferenceDevice: output.inferenceDevice,
        transcriptionMode: "local",
        transcriptionPrompt: this.prompt,
        transcriptionDurationMs: Math.round(output.durationMs),
      },
      warnings: [],
    };
  }
}
