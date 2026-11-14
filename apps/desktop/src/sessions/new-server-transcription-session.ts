import { getAppState } from "../store";
import type {
  TranscriptionFailureCode,
  TranscriptionSessionFinalizeOptions,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import {
  getNewServerIdToken,
  getNewServerWebSocketUrl,
  NotAuthenticatedError,
} from "../utils/new-server.utils";
import {
  buildPostProcessingPrompt,
  buildSystemPostProcessingTonePrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { getToneById, getToneConfig } from "../utils/tone.utils";
import {
  getMyUserName,
  loadMyEffectiveDictationLanguage,
} from "../utils/user.utils";
import { toErrorMessage } from "./streaming-session.utils";
import { WebSocketTranscriptionSession } from "./websocket-transcription-session";

// Retrying the same account cannot fix these, so recovery is skipped and the
// user is told why (the audio is still kept as a failed History entry).
const NON_RETRYABLE_ERROR_CODES: Record<string, TranscriptionFailureCode> = {
  QUOTA_EXCEEDED: "quota_exceeded",
  AUTH_FAILED: "auth_failed",
  AUTH_REQUIRED: "auth_failed",
};

const FINALIZE_TIMEOUT_MS = 15_000;
const FINALIZE_WITH_PROMPT_TIMEOUT_MS = 30_000;

type NewServerTranscript = {
  text: string;
  source: string;
  durationMs?: number;
  processed?: {
    text: string;
    durationMs?: number;
  };
};

type FinalizeOptions = {
  prompt?: string;
  systemPrompt?: string;
};

export const getNewServerTranscriptDelta = (
  previousTranscript: string,
  nextTranscript: string,
): string => {
  const previous = previousTranscript.trim();
  const next = nextTranscript.trim();

  if (!next) {
    return "";
  }

  if (!previous) {
    return next;
  }

  if (next.startsWith(previous)) {
    return next.slice(previous.length).trim();
  }

  return next;
};

/** Streams to /v1/dictation: auth -> config -> ready -> audio -> finalize -> transcript. */
export class NewServerTranscriptionSession extends WebSocketTranscriptionSession {
  readonly name = "NewServer";
  protected readonly metadata = {
    inferenceDevice: "Cloud • New Server (Streaming)",
    transcriptionMode: "cloud",
  } as const;
  protected readonly chunking = null;
  protected readonly closeCompletesFinalize = false;
  private config: { glossary: string[]; language: string } | null = null;
  private committedTranscript = "";
  private transcript: NewServerTranscript | null = null;
  private hasPrompt = false;

  protected async openSocket(
    _sampleRate: number,
    signal: AbortSignal,
  ): Promise<WebSocket> {
    const state = getAppState();
    this.config = {
      glossary: collectDictionaryEntries(state).sources,
      language: await loadMyEffectiveDictationLanguage(state),
    };
    signal.throwIfAborted();
    return new WebSocket(getNewServerWebSocketUrl("/v1/dictation"));
  }

  protected onSocketOpen(): void {
    void this.authenticate();
  }

  private async authenticate(): Promise<void> {
    try {
      const idToken = await getNewServerIdToken();
      this.send(JSON.stringify({ type: "auth", idToken }));
    } catch (error) {
      this.fail(
        `Authentication failed: ${toErrorMessage(error)}`,
        error instanceof NotAuthenticatedError ? "auth_failed" : undefined,
      );
    }
  }

  protected encodeAudio(samples: Float32Array): Float32Array {
    return samples;
  }

  protected handleMessage(data: unknown): void {
    const message = JSON.parse(String(data));
    switch (message.type) {
      case "error":
        this.fail(
          `Server error ${message.code}: ${message.message}`,
          NON_RETRYABLE_ERROR_CODES[message.code],
        );
        return;
      case "authenticated":
        this.send(
          JSON.stringify({
            type: "config",
            sampleRate: this.sampleRate,
            glossary: this.config?.glossary ?? [],
            language: this.config?.language,
          }),
        );
        return;
      case "ready":
        this.markReady();
        return;
      case "partial_transcript":
        if (message.is_final && message.text) {
          const nextTranscript = String(message.text).trim();
          const delta = getNewServerTranscriptDelta(
            this.committedTranscript,
            nextTranscript,
          );
          this.committedTranscript = nextTranscript;
          this.emitInterim(delta);
        }
        return;
      case "transcript":
        this.transcript = {
          text: String(message.text ?? ""),
          source: String(message.source ?? ""),
          durationMs: message.durationMs,
          processed: message.processed
            ? {
                text: message.processed.text,
                durationMs: message.processed.durationMs,
              }
            : undefined,
        };
        getLogger().info("[NewServer] Transcript received:", {
          length: this.transcript.text.length,
          source: this.transcript.source,
          hasProcessed: !!this.transcript.processed,
        });
        this.complete();
        return;
    }
  }

  protected async sendFinalizeRequest(
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<void> {
    const finalizeOptions = await this.buildFinalizeOptions(options);
    this.hasPrompt = !!finalizeOptions?.prompt;
    this.send(
      JSON.stringify({
        type: "finalize",
        ...(finalizeOptions?.prompt ? { prompt: finalizeOptions.prompt } : {}),
        ...(finalizeOptions?.systemPrompt
          ? { systemPrompt: finalizeOptions.systemPrompt }
          : {}),
      }),
    );
  }

  protected getFinalizeTimeoutMs(): number {
    return this.hasPrompt
      ? FINALIZE_WITH_PROMPT_TIMEOUT_MS
      : FINALIZE_TIMEOUT_MS;
  }

  protected onFinalizeTimeout(timeoutMs: number): void {
    this.fail(`Server did not return a transcript within ${timeoutMs / 1000}s`);
  }

  protected buildResult() {
    const transcript = this.transcript;
    return {
      rawTranscript: transcript?.text || null,
      processedTranscript: transcript?.processed?.text || null,
      metadata: {
        inferenceDevice: `Cloud • ${transcript?.source || "New Server"}`,
        transcriptionMode: "cloud" as const,
        transcriptionDurationMs: transcript?.durationMs ?? null,
      },
      postProcessMetadata: transcript?.processed
        ? {
            postProcessMode: "cloud" as const,
            postProcessDevice: "Cloud • Dictation Server",
            postprocessDurationMs: transcript.processed.durationMs ?? null,
          }
        : undefined,
    };
  }

  private async buildFinalizeOptions(
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<FinalizeOptions | undefined> {
    const state = getAppState();
    if (state.activeRecordingMode !== "dictate") {
      return undefined;
    }

    const toneId = options?.toneId ?? null;
    const tone = getToneById(state, toneId);
    if (tone?.shouldDisablePostProcessing) {
      return undefined;
    }

    const toneConfig = getToneConfig(state, toneId);
    const dictationLanguage = await loadMyEffectiveDictationLanguage(state);
    const promptInput = {
      transcript: "{{transcript}}",
      userName: getMyUserName(state),
      dictationLanguage,
      tone: toneConfig,
    };

    return {
      prompt: buildPostProcessingPrompt(promptInput),
      systemPrompt: buildSystemPostProcessingTonePrompt(promptInput),
    };
  }
}
