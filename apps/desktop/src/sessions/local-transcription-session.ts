import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import {
  type LocalSidecarStreamingSession,
  getLocalTranscriptionSidecarManager,
} from "../sidecars";
import { getLogger } from "../utils/log.utils";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { mapDictationLanguageToWhisperLanguage } from "../utils/language.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { AudioChunkRelay, toErrorMessage } from "./streaming-session.utils";

export class LocalTranscriptionSession implements TranscriptionSession {
  private relay: AudioChunkRelay | null = null;
  private session: LocalSidecarStreamingSession | null = null;
  private prompt: string | null = null;
  private startFailureReason: string | null = null;

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.cleanup();
    this.startFailureReason = null;

    try {
      this.relay = await AudioChunkRelay.start();

      const state = getAppState();
      const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
      const whisperLanguage =
        mapDictationLanguageToWhisperLanguage(dictationLanguage);
      const prompt = buildLocalizedTranscriptionPrompt({
        entries: collectDictionaryEntries(state),
        dictationLanguage,
        state,
      });

      const settings = state.settings.aiTranscription;
      const sidecarSession =
        await getLocalTranscriptionSidecarManager().createStreamingSession({
          model: normalizeLocalWhisperModel(settings.modelSize),
          preferGpu: isGpuPreferredTranscriptionDevice(settings.device),
          sampleRate,
          language: whisperLanguage,
          initialPrompt: prompt || undefined,
          deviceId: getTranscriptionSidecarDeviceId(settings.device),
        });
      if (!this.relay) {
        sidecarSession.cleanup();
        return;
      }

      this.session = sidecarSession;
      this.prompt = prompt;
      this.relay.pipeTo((samples) => sidecarSession.writeAudioChunk(samples));
    } catch (error) {
      const message = toErrorMessage(error);
      this.startFailureReason = `Local streaming session unavailable (${message})`;
      getLogger().warning(`[local-stream-session] start failed (${message})`);
      this.cleanup();
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const session = this.session;
    if (!session) {
      return this.failure(
        this.startFailureReason ?? "Local streaming session not established",
      );
    }

    this.relay?.stop();
    try {
      getLogger().info(`[local-stream-session] finalizing streaming session`);
      const output = await session.finalize();
      getLogger().info(
        `[local-stream-session] streaming finalize succeeded (${output.text.length} chars)`,
      );
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
    } catch (error) {
      const message = toErrorMessage(error);
      getLogger().warning(
        `[local-stream-session] finalize failed (${message})`,
      );
      return this.failure(`Local streaming transcription failed (${message})`);
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    this.relay?.stop();
    this.relay = null;
    this.session?.cleanup();
    this.session = null;
  }

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  private failure(failureReason: string): TranscriptionSessionResult {
    return {
      rawTranscript: null,
      metadata: {
        transcriptionMode: "local",
        transcriptionPrompt: this.prompt,
      },
      warnings: [],
      failureReason,
    };
  }
}
