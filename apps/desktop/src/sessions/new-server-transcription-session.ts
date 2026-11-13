import { getAppState } from "../store";
import {
  InterimResultCallback,
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionFinalizeOptions,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { getLogger } from "../utils/log.utils";
import {
  getNewServerIdToken,
  getNewServerWebSocketUrl,
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
import {
  AudioChunkRelay,
  closeSocket,
  getStalledUploadFailure,
  STREAM_CONNECT_TIMEOUT_MS,
  toErrorMessage,
} from "./streaming-session.utils";

const FINALIZE_TIMEOUT_MS = 15_000;
const FINALIZE_WITH_PROMPT_TIMEOUT_MS = 30_000;
const FLOAT32_BYTES = 4;
const INFERENCE_DEVICE = "Cloud • New Server (Streaming)";

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

export type NewServerFinalizeOutcome =
  | { transcript: NewServerTranscript }
  | { failureReason: string };

export type NewServerDictationStreamConfig = {
  url: string;
  sampleRate: number;
  glossary: string[];
  language?: string;
  getIdToken: () => Promise<string>;
  onInterimSegment?: InterimResultCallback;
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

/**
 * One /v1/dictation WebSocket for one recording. Any problem (handshake,
 * drop, server error, stall, finalize timeout) settles it with a failure
 * reason instead of a partial transcript, so the caller can re-transcribe the
 * full recording.
 */
export class NewServerDictationStream {
  private ws: WebSocket | null = null;
  private relay: AudioChunkRelay | null = null;
  private failureReason: string | null = null;
  private isReady = false;
  private isFinalizing = false;
  private isComplete = false;
  private committedTranscript = "";
  private sentChunkCount = 0;
  private readyPromise: Promise<void> | null = null;
  private rejectReady: ((error: Error) => void) | null = null;
  private resolveFinalize:
    | ((outcome: NewServerFinalizeOutcome) => void)
    | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(private readonly config: NewServerDictationStreamConfig) {}

  start(): Promise<void> {
    this.readyPromise ??= this.connect();
    return this.readyPromise;
  }

  async finalize(options?: FinalizeOptions): Promise<NewServerFinalizeOutcome> {
    try {
      await this.start();
    } catch {
      return { failureReason: this.failureReason ?? "Stream failed to start" };
    }

    if (this.failureReason) {
      return { failureReason: this.failureReason };
    }

    this.isFinalizing = true;
    this.relay?.stop();

    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return this.fail("Connection closed before finalize");
    }

    const stalled = getStalledUploadFailure(
      ws,
      this.config.sampleRate * FLOAT32_BYTES,
    );
    if (stalled) {
      return this.fail(stalled);
    }

    const timeoutMs = options?.prompt
      ? FINALIZE_WITH_PROMPT_TIMEOUT_MS
      : FINALIZE_TIMEOUT_MS;
    const outcome = new Promise<NewServerFinalizeOutcome>((resolve) => {
      this.resolveFinalize = resolve;
    });

    try {
      ws.send(
        JSON.stringify({
          type: "finalize",
          ...(options?.prompt ? { prompt: options.prompt } : {}),
          ...(options?.systemPrompt
            ? { systemPrompt: options.systemPrompt }
            : {}),
        }),
      );
    } catch (error) {
      return this.fail(`Failed to send finalize: ${toErrorMessage(error)}`);
    }

    getLogger().info(
      `[NewServer WebSocket] Finalize sent (sent=${this.sentChunkCount}, hasPrompt=${!!options?.prompt})`,
    );
    this.setTimer(timeoutMs, () =>
      this.fail(
        `Server did not return a transcript within ${timeoutMs / 1000}s`,
      ),
    );
    return await outcome;
  }

  close(): void {
    this.fail("Stream closed");
  }

  private async connect(): Promise<void> {
    this.relay = await AudioChunkRelay.start();
    if (this.failureReason) {
      this.relay.stop();
      throw new Error(this.failureReason);
    }

    return new Promise<void>((resolve, reject) => {
      this.rejectReady = reject;
      this.setTimer(STREAM_CONNECT_TIMEOUT_MS, () =>
        this.fail(
          `Server not ready within ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`,
        ),
      );

      const ws = new WebSocket(this.config.url);
      this.ws = ws;

      ws.onopen = async () => {
        try {
          const idToken = await this.config.getIdToken();
          ws.send(JSON.stringify({ type: "auth", idToken }));
        } catch (error) {
          this.fail(`Authentication failed: ${toErrorMessage(error)}`);
        }
      };

      ws.onmessage = (event) => {
        if (this.failureReason || this.isComplete) {
          return;
        }
        this.handleMessage(event.data, resolve);
      };

      ws.onerror = () => {
        this.fail("WebSocket error");
      };

      ws.onclose = (event) => {
        this.fail(
          `Connection closed (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`,
        );
      };
    });
  }

  private handleMessage(data: unknown, resolveReady: () => void): void {
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(String(data));
    } catch (error) {
      getLogger().warning(
        `[NewServer WebSocket] Ignoring unparsable message: ${toErrorMessage(error)}`,
      );
      return;
    }

    switch (msg.type) {
      case "error":
        this.fail(`Server error ${msg.code}: ${msg.message}`);
        return;
      case "authenticated":
        this.ws?.send(
          JSON.stringify({
            type: "config",
            sampleRate: this.config.sampleRate,
            glossary: this.config.glossary,
            language: this.config.language,
          }),
        );
        return;
      case "ready":
        this.clearTimer();
        this.isReady = true;
        this.rejectReady = null;
        this.relay?.pipeTo((samples) => this.sendChunk(samples));
        getLogger().info(
          `[NewServer WebSocket] Ready, flushed ${this.sentChunkCount} buffered chunks`,
        );
        resolveReady();
        return;
      case "partial_transcript":
        if (msg.is_final && msg.text && !this.isFinalizing) {
          const nextTranscript = String(msg.text).trim();
          const delta = getNewServerTranscriptDelta(
            this.committedTranscript,
            nextTranscript,
          );
          this.committedTranscript = nextTranscript;
          if (delta) {
            this.config.onInterimSegment?.(delta);
          }
        }
        return;
      case "transcript": {
        if (!this.resolveFinalize) {
          return;
        }
        const processed = msg.processed as NewServerTranscript["processed"];
        this.isComplete = true;
        this.settle({
          transcript: {
            text: String(msg.text ?? ""),
            source: String(msg.source ?? ""),
            durationMs: msg.durationMs as number | undefined,
            processed: processed
              ? { text: processed.text, durationMs: processed.durationMs }
              : undefined,
          },
        });
        return;
      }
    }
  }

  private sendChunk(samples: Float32Array): void {
    if (this.isFinalizing || this.failureReason) {
      return;
    }
    const ws = this.ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      this.fail("Connection lost during recording");
      return;
    }
    try {
      ws.send(samples);
      this.sentChunkCount++;
    } catch (error) {
      this.fail(`Failed to send audio: ${toErrorMessage(error)}`);
    }
  }

  private fail(reason: string): NewServerFinalizeOutcome {
    if (!this.failureReason && !this.isComplete) {
      this.failureReason = reason;
      getLogger().warning(
        `[NewServer WebSocket] ${reason} (ready=${this.isReady}, finalizing=${this.isFinalizing}, sent=${this.sentChunkCount})`,
      );
    }
    const outcome = { failureReason: this.failureReason ?? reason };
    this.settle(outcome);
    return outcome;
  }

  private settle(outcome: NewServerFinalizeOutcome): void {
    this.clearTimer();
    this.relay?.stop();

    closeSocket(this.ws);
    this.ws = null;

    const rejectReady = this.rejectReady;
    this.rejectReady = null;
    rejectReady?.(new Error(this.failureReason ?? "Stream closed"));

    const resolveFinalize = this.resolveFinalize;
    this.resolveFinalize = null;
    resolveFinalize?.(outcome);
  }

  private setTimer(timeoutMs: number, onTimeout: () => void): void {
    this.clearTimer();
    this.timer = setTimeout(onTimeout, timeoutMs);
  }

  private clearTimer(): void {
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }
}

export class NewServerTranscriptionSession implements TranscriptionSession {
  private stream: NewServerDictationStream | null = null;
  private interimCallback: InterimResultCallback | null = null;

  async onRecordingStart(sampleRate: number): Promise<void> {
    const state = getAppState();
    const language = await loadMyEffectiveDictationLanguage(state);
    this.stream = new NewServerDictationStream({
      url: getNewServerWebSocketUrl("/v1/dictation"),
      sampleRate,
      glossary: collectDictionaryEntries(state).sources,
      language,
      getIdToken: getNewServerIdToken,
      onInterimSegment: this.interimCallback ?? undefined,
    });
    await this.stream.start();
    getLogger().info("[NewServer] Streaming session started");
  }

  async finalize(
    _audio: StopRecordingResponse,
    options?: TranscriptionSessionFinalizeOptions,
  ): Promise<TranscriptionSessionResult> {
    if (!this.stream) {
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: INFERENCE_DEVICE,
          transcriptionMode: "cloud",
        },
        warnings: [],
        failureReason: "New server streaming session was not established",
      };
    }

    const outcome = await this.stream.finalize(
      await this.buildFinalizeOptions(options),
    );
    if ("failureReason" in outcome) {
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: INFERENCE_DEVICE,
          transcriptionMode: "cloud",
        },
        warnings: [],
        failureReason: outcome.failureReason,
      };
    }

    const { transcript } = outcome;
    getLogger().info("[NewServer] Transcript received:", {
      length: transcript.text.length,
      source: transcript.source,
      durationMs: transcript.durationMs,
      hasProcessed: !!transcript.processed,
    });

    return {
      rawTranscript: transcript.text || null,
      processedTranscript: transcript.processed?.text || null,
      metadata: {
        inferenceDevice: `Cloud • ${transcript.source || "New Server"}`,
        transcriptionMode: "cloud",
        transcriptionDurationMs: transcript.durationMs ?? null,
      },
      postProcessMetadata: transcript.processed
        ? {
            postProcessMode: "cloud",
            postProcessDevice: "Cloud • Dictation Server",
            postprocessDurationMs: transcript.processed.durationMs ?? null,
          }
        : undefined,
      warnings: [],
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

  cleanup(): void {
    this.stream?.close();
    this.stream = null;
  }

  supportsStreaming(): boolean {
    return true;
  }

  setInterimResultCallback(callback: InterimResultCallback): void {
    this.interimCallback = callback;
  }
}
