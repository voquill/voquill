import {
  AzureStreamingSession,
  createAzureStreamingSession,
} from "@voquill/voice-ai";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import {
  AudioChunkRelay,
  STREAM_CONNECT_TIMEOUT_MS,
  toErrorMessage,
  withTimeout,
} from "./streaming-session.utils";

const AZURE_METADATA = {
  inferenceDevice: "API • Azure (Streaming)",
  transcriptionMode: "api",
} as const;

export class AzureTranscriptionSession implements TranscriptionSession {
  private session: AzureStreamingSession | null = null;
  private relay: AudioChunkRelay | null = null;
  private failureReason: string | null = null;
  private subscriptionKey: string;
  private region: string;

  constructor(subscriptionKey: string, region: string) {
    this.subscriptionKey = subscriptionKey;
    this.region = region;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    try {
      console.log("[Azure] Starting streaming session...");
      this.relay = await AudioChunkRelay.start();

      const state = getAppState();
      const language = await loadMyEffectiveDictationLanguage(state);
      const dictionaryEntries = collectDictionaryEntries(state);
      const prompt = buildLocalizedTranscriptionPrompt({
        entries: dictionaryEntries,
        dictationLanguage: language,
        state,
      });

      const creation = createAzureStreamingSession({
        subscriptionKey: this.subscriptionKey,
        region: this.region,
        sampleRate,
        language,
        prompt: prompt || undefined,
      });
      const session = await withTimeout(
        creation,
        STREAM_CONNECT_TIMEOUT_MS,
      ).catch((error) => {
        creation.then((late) => late.cleanup()).catch(() => {});
        throw error;
      });
      if (!this.relay) {
        session.cleanup();
        return;
      }

      this.session = session;
      this.relay.pipeTo((chunk) => {
        if (this.failureReason) {
          return;
        }
        try {
          session.writeAudioChunk(chunk);
        } catch (error) {
          this.failureReason = `Failed to write audio: ${toErrorMessage(error)}`;
          this.relay?.stop();
        }
      });

      console.log("[Azure] Streaming session started successfully");
    } catch (error) {
      console.error("[Azure] Failed to start streaming:", error);
      this.failureReason = `Azure streaming session was not established: ${toErrorMessage(error)}`;
      this.relay?.stop();
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    const session = this.session;
    if (!session) {
      return this.failure(
        this.failureReason ?? "Azure streaming session was not established",
      );
    }

    this.relay?.stop();
    const errorBeforeFinalize = this.getStreamFailure(session);
    if (errorBeforeFinalize) {
      return this.failure(errorBeforeFinalize);
    }

    console.log("[Azure] Finalizing streaming session...");
    const finalizeStart = performance.now();
    const transcript = await session.finalize();
    const durationMs = Math.round(performance.now() - finalizeStart);

    const errorDuringFinalize = this.getStreamFailure(session);
    if (errorDuringFinalize) {
      return this.failure(errorDuringFinalize);
    }

    console.log("[Azure] Transcript received:", {
      durationMs,
      length: transcript.length,
    });
    return {
      rawTranscript: transcript || null,
      metadata: { ...AZURE_METADATA, transcriptionDurationMs: durationMs },
      warnings: [],
    };
  }

  cleanup(): void {
    this.relay?.stop();
    this.relay = null;
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
  }

  supportsStreaming(): boolean {
    return false;
  }

  setInterimResultCallback(): void {}

  private getStreamFailure(session: AzureStreamingSession): string | null {
    if (this.failureReason) {
      return this.failureReason;
    }
    const recognitionError = session.getError();
    return recognitionError
      ? `Azure recognition canceled: ${recognitionError}`
      : null;
  }

  private failure(failureReason: string): TranscriptionSessionResult {
    return {
      rawTranscript: null,
      metadata: AZURE_METADATA,
      warnings: [],
      failureReason,
    };
  }
}
