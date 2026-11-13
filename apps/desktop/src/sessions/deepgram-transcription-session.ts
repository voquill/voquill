import { convertFloat32ToPCM16 } from "@voquill/voice-ai";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import { getAppState } from "../store";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import { buildDeepgramWebSocketUrl } from "../utils/deepgram.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import {
  closeSocket,
  getAbnormalCloseFailure,
  getStalledUploadFailure,
  STREAM_CONNECT_TIMEOUT_MS,
  StreamingFinalizeOutcome,
  toErrorMessage,
} from "./streaming-session.utils";

const PCM16_BYTES = 2;

type DeepgramStreamingSession = {
  finalize: () => Promise<StreamingFinalizeOutcome>;
  cleanup: () => void;
};

const startDeepgramStreaming = async (
  apiKey: string,
  sampleRate: number,
  language: string,
  onInterimResult?: (segment: string) => void,
): Promise<DeepgramStreamingSession> => {
  console.log("[Deepgram WebSocket] Starting with sample rate:", sampleRate);
  const MIN_CHUNK_DURATION_MS = 20;
  const MAX_CHUNK_DURATION_MS = 100;
  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * MIN_CHUNK_DURATION_MS) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * MAX_CHUNK_DURATION_MS) / 1000),
  );

  let ws: WebSocket | null = null;
  let unlisten: UnlistenFn | null = null;
  let finalTranscript = "";
  let partialTranscript = "";
  let isFinalized = false;
  let failureReason: string | null = null;
  let receivedChunkCount = 0;
  let sentChunkCount = 0;
  let pendingSampleCount = 0;
  let pendingChunks: Float32Array[] = [];

  const getText = () => {
    return (
      finalTranscript +
      (partialTranscript
        ? (finalTranscript ? " " : "") + partialTranscript
        : "")
    );
  };

  const resetBuffers = () => {
    pendingChunks = [];
    pendingSampleCount = 0;
  };

  const drainSamples = (targetCount: number): Float32Array => {
    if (targetCount <= 0) {
      return new Float32Array(0);
    }
    const output = new Float32Array(targetCount);
    let filled = 0;

    while (filled < targetCount && pendingChunks.length > 0) {
      const current = pendingChunks[0];
      const remaining = targetCount - filled;
      if (current.length <= remaining) {
        output.set(current, filled);
        filled += current.length;
        pendingChunks.shift();
      } else {
        output.set(current.subarray(0, remaining), filled);
        pendingChunks[0] = current.subarray(remaining);
        filled += remaining;
      }
    }

    pendingSampleCount = Math.max(0, pendingSampleCount - filled);
    return filled === targetCount ? output : output.subarray(0, filled);
  };

  const flushPendingSamples = (force = false) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return;
    }

    while (
      pendingSampleCount >= minSamplesPerChunk ||
      (force && pendingSampleCount > 0)
    ) {
      const available = pendingSampleCount;
      let chunkSize = available;
      if (available >= maxSamplesPerChunk) {
        chunkSize = maxSamplesPerChunk;
      } else if (available < minSamplesPerChunk && !force) {
        break;
      }

      let chunk = drainSamples(chunkSize);
      if (force && chunk.length > 0 && chunk.length < minSamplesPerChunk) {
        const padded = new Float32Array(minSamplesPerChunk);
        padded.set(chunk);
        chunk = padded;
      }

      if (chunk.length === 0) {
        break;
      }

      try {
        const pcm16 = convertFloat32ToPCM16(chunk);
        ws.send(pcm16);
        sentChunkCount++;
        if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
          const durationMs = (chunk.length / sampleRate) * 1000;
          console.log(
            `[Deepgram WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${pcm16.byteLength} bytes)`,
          );
        }
      } catch (error) {
        console.error(
          "[Deepgram WebSocket] Error sending buffered chunk:",
          error,
        );
        break;
      }
    }
  };

  const cleanup = () => {
    if (unlisten) {
      unlisten();
      unlisten = null;
    }
    closeSocket(ws);
    ws = null;
    resetBuffers();
  };

  let finalizeResolver: ((outcome: StreamingFinalizeOutcome) => void) | null =
    null;
  let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

  const settleFinalize = (outcome: StreamingFinalizeOutcome) => {
    if (finalizeTimeout) {
      clearTimeout(finalizeTimeout);
      finalizeTimeout = null;
    }
    cleanup();
    const resolver = finalizeResolver;
    finalizeResolver = null;
    resolver?.(outcome);
  };

  const fail = (reason: string) => {
    if (failureReason) {
      return;
    }
    failureReason = reason;
    console.warn(`[Deepgram WebSocket] ${reason}`);
    settleFinalize({ failureReason: reason });
  };

  const finalize = (): Promise<StreamingFinalizeOutcome> => {
    return new Promise((resolveFinalize) => {
      console.log(
        "[Deepgram WebSocket] Finalize called, isFinalized:",
        isFinalized,
        "ws state:",
        ws?.readyState,
      );
      if (failureReason) {
        resolveFinalize({ failureReason });
        return;
      }
      if (isFinalized) {
        resolveFinalize({ failureReason: "Stream was already finalized" });
        return;
      }

      isFinalized = true;
      finalizeResolver = resolveFinalize;
      flushPendingSamples(true);
      console.log("[Deepgram WebSocket] Total chunks sent:", sentChunkCount);

      if (!ws || ws.readyState !== WebSocket.OPEN) {
        fail("Connection closed before finalize");
        return;
      }

      const stalled = getStalledUploadFailure(ws, sampleRate * PCM16_BYTES);
      if (stalled) {
        fail(stalled);
        return;
      }

      console.log("[Deepgram WebSocket] Sending CloseStream message...");
      ws.send(JSON.stringify({ type: "CloseStream" }));

      finalizeTimeout = setTimeout(() => {
        fail("Deepgram did not close the stream within 3s of CloseStream");
      }, 3000);
    });
  };

  const completeFinalize = () => {
    if (finalizeResolver && !failureReason) {
      console.log(
        "[Deepgram WebSocket] Completing finalize with transcript length:",
        getText().length,
      );
      settleFinalize({ text: getText() });
    }
  };

  // Start listening for audio chunks IMMEDIATELY, before the WebSocket connects.
  // This buffers audio so nothing is lost during the connection handshake.
  console.log("[Deepgram WebSocket] Setting up audio_chunk listener...");
  unlisten = await listen<{ samples: number[] }>("audio_chunk", (event) => {
    receivedChunkCount++;
    if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
      console.log(
        `[Deepgram WebSocket] Received chunk #${receivedChunkCount}, samples:`,
        event.payload.samples.length,
      );
    }
    if (!isFinalized) {
      try {
        const typedChunk =
          event.payload.samples instanceof Float32Array
            ? event.payload.samples
            : Float32Array.from(event.payload.samples);
        pendingChunks.push(typedChunk);
        pendingSampleCount += typedChunk.length;
        flushPendingSamples(false);
      } catch (error) {
        console.error("[Deepgram WebSocket] Error sending audio chunk:", error);
      }
    }
  });
  console.log("[Deepgram WebSocket] Audio listener attached, connecting...");

  return new Promise((resolve, reject) => {
    const wsUrl = buildDeepgramWebSocketUrl({
      sampleRate,
      language,
    });
    console.log("[Deepgram WebSocket] Connecting to:", wsUrl);
    ws = new WebSocket(wsUrl, ["token", apiKey]);
    let isOpen = false;
    const connectTimeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Deepgram connection not open within ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, STREAM_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      isOpen = true;
      clearTimeout(connectTimeout);
      console.log("[Deepgram WebSocket] Connected, flushing buffered audio...");
      flushPendingSamples(false);
      console.log("[Deepgram WebSocket] Session ready");
      resolve({ finalize, cleanup });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const messageType = data.type;
        console.log(
          "[Deepgram WebSocket] Received message:",
          messageType,
          data,
        );

        if (messageType === "Results") {
          const transcript = data.channel?.alternatives?.[0]?.transcript || "";
          const isFinal = data.is_final === true;
          const speechFinal = data.speech_final === true;

          if (isFinal && transcript) {
            finalTranscript += (finalTranscript ? " " : "") + transcript;
            partialTranscript = "";
            console.log(
              "[Deepgram WebSocket] Final transcript received, length:",
              finalTranscript.length,
            );
            if (onInterimResult) {
              onInterimResult(transcript);
            }
            if (speechFinal && isFinalized) {
              completeFinalize();
            }
          } else if (!isFinal && transcript) {
            partialTranscript = transcript;
          }
        } else if (messageType === "Metadata") {
          console.log("[Deepgram WebSocket] Metadata received:", data);
        } else if (messageType === "Error" || data.error) {
          console.error("[Deepgram WebSocket] Error from server:", data);
          fail(
            `Deepgram error: ${data.description ?? data.message ?? data.error ?? "unknown"}`,
          );
        }
      } catch (error) {
        console.error("[Deepgram WebSocket] Error parsing message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("[Deepgram WebSocket] WebSocket error:", error);
      if (!isOpen) {
        clearTimeout(connectTimeout);
        cleanup();
        reject(new Error("WebSocket connection failed"));
        return;
      }
      fail("WebSocket error");
    };

    ws.onclose = (event) => {
      console.log("[Deepgram WebSocket] WebSocket closed:", {
        code: event.code,
        reason: event.reason,
      });
      const abnormalClose = getAbnormalCloseFailure(event);
      if (isFinalized && finalizeResolver && !abnormalClose) {
        completeFinalize();
      } else {
        fail(
          abnormalClose ??
            `Connection closed during recording (code=${event.code})`,
        );
      }
      cleanup();
    };
  });
};

const DEEPGRAM_METADATA = {
  inferenceDevice: "API • Deepgram (Streaming)",
  transcriptionMode: "api",
} as const;

export class DeepgramTranscriptionSession implements TranscriptionSession {
  private session: DeepgramStreamingSession | null = null;
  private startupPromise: Promise<void> | null = null;
  private startFailureReason: string | null = null;
  private apiKey: string;
  private interimCallback: ((segment: string) => void) | null = null;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  supportsStreaming(): boolean {
    return true;
  }

  setInterimResultCallback(callback: (segment: string) => void): void {
    this.interimCallback = callback;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    this.startupPromise = (async () => {
      try {
        const state = getAppState();
        const deepgramLanguage = await loadMyEffectiveDictationLanguage(state);

        console.log("[Deepgram] Starting streaming session...");
        this.session = await startDeepgramStreaming(
          this.apiKey,
          sampleRate,
          deepgramLanguage,
          this.interimCallback ?? undefined,
        );
        console.log("[Deepgram] Streaming session started successfully");
      } catch (error) {
        console.error("[Deepgram] Failed to start streaming:", error);
        this.startFailureReason = toErrorMessage(error);
      }
    })();
    await this.startupPromise;
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (this.startupPromise) {
      await this.startupPromise;
    }

    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: DEEPGRAM_METADATA,
        warnings: [],
        failureReason: `Deepgram streaming session was not established${this.startFailureReason ? `: ${this.startFailureReason}` : ""}`,
      };
    }

    console.log("[Deepgram] Finalizing streaming session...");
    const finalizeStart = performance.now();
    const outcome = await this.session.finalize();
    const durationMs = Math.round(performance.now() - finalizeStart);
    if ("failureReason" in outcome) {
      return {
        rawTranscript: null,
        metadata: DEEPGRAM_METADATA,
        warnings: [],
        failureReason: outcome.failureReason,
      };
    }

    console.log("[Deepgram] Transcript received:", {
      durationMs,
      length: outcome.text.length,
    });
    return {
      rawTranscript: outcome.text || null,
      metadata: { ...DEEPGRAM_METADATA, transcriptionDurationMs: durationMs },
      warnings: [],
    };
  }

  cleanup(): void {
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
  }
}
