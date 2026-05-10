import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { transcribeAudio } from "../actions/transcribe.actions";
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
import { readAudioFromFile } from "../utils/audio.utils";
import { getLogger } from "../utils/log.utils";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { mapDictationLanguageToWhisperLanguage } from "../utils/language.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";

type AudioChunkPayload = {
  samples: number[];
};

type LocalSessionContext = {
  prompt: string;
};

export class LocalTranscriptionSession implements TranscriptionSession {
  private unlisten: UnlistenFn | null = null;
  private session: LocalSidecarStreamingSession | null = null;
  private context: LocalSessionContext | null = null;
  private startupWarnings: string[] = [];

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.cleanup();
    this.startupWarnings = [];

    try {
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

      this.session = sidecarSession;
      this.context = { prompt };
      this.unlisten = await listen<AudioChunkPayload>(
        "audio_chunk",
        (event) => {
          if (!this.session || !event.payload.samples.length) {
            return;
          }
          this.session.writeAudioChunk(event.payload.samples);
        },
      );
    } catch (error) {
      const message = this.toErrorMessage(error);
      this.startupWarnings.push(
        `Local streaming session unavailable, falling back to batch mode (${message})`,
      );
      getLogger().warning(
        `[local-stream-session] start failed, falling back (${message})`,
      );
      this.cleanup();
    }
  }

  async finalize(
    audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const warnings = [...this.startupWarnings];

    if (!this.session) {
      getLogger().info(
        `[local-stream-session] no streaming session, using batch fallback`,
      );
      return await this.finalizeWithBatchFallback(audio, warnings);
    }

    try {
      getLogger().info(`[local-stream-session] finalizing streaming session`);
      const output = await this.session.finalize();
      getLogger().info(
        `[local-stream-session] streaming finalize succeeded (${output.text.length} chars)`,
      );
      return {
        rawTranscript: output.text.trim() || null,
        metadata: {
          modelSize: output.model,
          inferenceDevice: output.inferenceDevice,
          transcriptionMode: "local",
          transcriptionPrompt: this.context?.prompt ?? null,
          transcriptionDurationMs: Math.round(output.durationMs),
        },
        warnings,
      };
    } catch (error) {
      const message = this.toErrorMessage(error);
      const errorName = error instanceof Error ? error.name : typeof error;
      warnings.push(
        `Local streaming transcription failed, falling back to batch mode (${message})`,
      );
      getLogger().warning(
        `[local-stream-session] finalize failed [${errorName}], falling back to batch (${message})`,
      );
      return await this.finalizeWithBatchFallback(audio, warnings);
    } finally {
      this.cleanup();
    }
  }

  cleanup(): void {
    getLogger().info(
      `[local-stream-session] cleanup (hasSession=${!!this.session}, hasUnlisten=${!!this.unlisten})`,
    );
    this.unlisten?.();
    this.unlisten = null;
    this.session?.cleanup();
    this.session = null;
    this.context = null;
  }

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  private async finalizeWithBatchFallback(
    audio: StopRecordingResponse,
    warnings: string[],
  ): Promise<TranscriptionSessionResult> {
    const rate = audio.sampleRate;

    if (rate == null || rate <= 0 || !audio.filePath || audio.sampleCount === 0) {
      getLogger().warning(
        `[local-stream-session] batch fallback: skipping transcription (rate=${rate}, sampleCount=${audio.sampleCount})`,
      );
      return {
        rawTranscript: null,
        metadata: {
          transcriptionMode: "local",
          transcriptionPrompt: this.context?.prompt ?? null,
        },
        warnings,
      };
    }

    getLogger().info(
      `[local-stream-session] batch fallback: reading ${audio.sampleCount} samples at ${rate}Hz from file`,
    );
    const { samples } = await readAudioFromFile(audio.filePath);

    const result = await transcribeAudio({
      samples,
      sampleRate: rate,
    });
    getLogger().info(
      `[local-stream-session] batch fallback: transcription complete (${result.rawTranscript.length} chars)`,
    );

    return {
      rawTranscript: result.rawTranscript,
      metadata: result.metadata,
      warnings: [...warnings, ...result.warnings],
    };
  }

  private toErrorMessage(error: unknown): string {
    if (error instanceof Error) {
      return error.message;
    }
    return String(error);
  }
}
