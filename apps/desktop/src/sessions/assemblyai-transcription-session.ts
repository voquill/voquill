import { convertFloat32ToPCM16 } from "@voquill/voice-ai";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";
import {
  AudioChunkRelay,
  closeSocket,
  getAbnormalCloseFailure,
  getStalledUploadFailure,
  STREAM_CONNECT_TIMEOUT_MS,
  StreamingFinalizeOutcome,
  toErrorMessage,
} from "./streaming-session.utils";

const PCM16_BYTES = 2;

type AssemblyAIStreamingSession = {
  finalize: () => Promise<StreamingFinalizeOutcome>;
  cleanup: () => void;
};

const startAssemblyAIStreaming = async (
  apiKey: string,
  sampleRate: number,
  onInterimResult?: (segment: string) => void,
): Promise<AssemblyAIStreamingSession> => {
  console.log("[AssemblyAI WebSocket] Starting with sample rate:", sampleRate);
  const MIN_CHUNK_DURATION_MS = 50;
  const MAX_CHUNK_DURATION_MS = 100;
  const minSamplesPerChunk = Math.max(
    1,
    Math.ceil((sampleRate * MIN_CHUNK_DURATION_MS) / 1000),
  );
  const maxSamplesPerChunk = Math.max(
    minSamplesPerChunk,
    Math.ceil((sampleRate * MAX_CHUNK_DURATION_MS) / 1000),
  );
  const relay = await AudioChunkRelay.start();

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let finalTranscript = "";
    let isFinalized = false;
    let failureReason: string | null = null;
    let sentChunkCount = 0;
    let pendingSampleCount = 0;
    let pendingChunks: Float32Array[] = [];

    let currentTurn = 0;
    let extra = "";

    const getText = () => {
      return (
        finalTranscript + (extra ? (finalTranscript ? " " : "") + extra : "")
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
              `[AssemblyAI WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms, ${pcm16.byteLength} bytes)`,
            );
          }
        } catch (error) {
          console.error(
            "[AssemblyAI WebSocket] Error sending buffered chunk:",
            error,
          );
          break;
        }
      }
    };

    const cleanup = () => {
      relay.stop();
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
      console.warn(`[AssemblyAI WebSocket] ${reason}`);
      settleFinalize({ failureReason: reason });
    };

    const finalize = (): Promise<StreamingFinalizeOutcome> => {
      return new Promise((resolveFinalize) => {
        console.log(
          "[AssemblyAI WebSocket] Finalize called, isFinalized:",
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
        console.log(
          "[AssemblyAI WebSocket] Total chunks sent:",
          sentChunkCount,
        );

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          fail("Connection closed before finalize");
          return;
        }

        const stalled = getStalledUploadFailure(ws, sampleRate * PCM16_BYTES);
        if (stalled) {
          fail(stalled);
          return;
        }

        console.log("[AssemblyAI WebSocket] Sending Terminate message...");
        ws.send(JSON.stringify({ type: "Terminate" }));

        finalizeTimeout = setTimeout(() => {
          fail("AssemblyAI did not terminate the stream within 2s");
        }, 2000);
      });
    };

    const completeFinalize = () => {
      if (finalizeResolver && !failureReason) {
        console.log(
          "[AssemblyAI WebSocket] Completing finalize with transcript length:",
          getText().length,
        );
        settleFinalize({ text: getText() });
      }
    };

    const wsUrl = `wss://streaming.assemblyai.com/v3/ws?sample_rate=${sampleRate}&token=${apiKey}`;
    console.log("[AssemblyAI WebSocket] Connecting...");
    ws = new WebSocket(wsUrl);
    let isOpen = false;
    const connectTimeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `AssemblyAI connection not open within ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, STREAM_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      isOpen = true;
      clearTimeout(connectTimeout);
      console.log("[AssemblyAI WebSocket] Connected, flushing buffered audio");
      relay.pipeTo((typedChunk) => {
        if (isFinalized) {
          return;
        }
        pendingChunks.push(typedChunk);
        pendingSampleCount += typedChunk.length;
        flushPendingSamples(false);
      });
      resolve({ finalize, cleanup });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        console.log("[AssemblyAI WebSocket] Received message:", data.type);

        if (data.type === "Turn" && data.end_of_turn) {
          const turnTranscript = data.transcript || "";
          finalTranscript += (finalTranscript ? " " : "") + turnTranscript;
          if (onInterimResult && turnTranscript) {
            onInterimResult(turnTranscript);
          }
          if (currentTurn === data.turn_order) {
            extra = "";
          }
        } else if (data.type === "Turn") {
          if (currentTurn != data.turn_order) {
            currentTurn = data.turn_order;

            extra = data.transcript;
          }
        } else if (data.type === "Termination") {
          completeFinalize();
        } else if (data.error) {
          fail(`AssemblyAI error: ${data.error}`);
        }
      } catch (error) {
        console.error("[AssemblyAI WebSocket] Error parsing message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("[AssemblyAI WebSocket] WebSocket error:", error);
      if (!isOpen) {
        clearTimeout(connectTimeout);
        cleanup();
        reject(new Error("WebSocket connection failed"));
        return;
      }
      fail("WebSocket error");
    };

    ws.onclose = (event) => {
      console.log("[AssemblyAI WebSocket] WebSocket closed:", {
        code: event.code,
        reason: event.reason,
      });
      const abnormalClose = getAbnormalCloseFailure(event);
      if (isFinalized && finalizeResolver && !abnormalClose) {
        completeFinalize();
      } else {
        fail(
          abnormalClose ??
            `Connection closed during recording (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`,
        );
      }
      cleanup();
    };
  });
};

const ASSEMBLYAI_METADATA = {
  inferenceDevice: "API • AssemblyAI (Streaming)",
  transcriptionMode: "api",
} as const;

export class AssemblyAITranscriptionSession implements TranscriptionSession {
  private session: AssemblyAIStreamingSession | null = null;
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
    try {
      console.log("[AssemblyAI] Starting streaming session...");
      this.session = await startAssemblyAIStreaming(
        this.apiKey,
        sampleRate,
        this.interimCallback ?? undefined,
      );
      console.log("[AssemblyAI] Streaming session started successfully");
    } catch (error) {
      console.error("[AssemblyAI] Failed to start streaming:", error);
      this.startFailureReason = toErrorMessage(error);
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: ASSEMBLYAI_METADATA,
        warnings: [],
        failureReason: `AssemblyAI streaming session was not established${this.startFailureReason ? `: ${this.startFailureReason}` : ""}`,
      };
    }

    console.log("[AssemblyAI] Finalizing streaming session...");
    const finalizeStart = performance.now();
    const outcome = await this.session.finalize();
    const durationMs = Math.round(performance.now() - finalizeStart);
    if ("failureReason" in outcome) {
      return {
        rawTranscript: null,
        metadata: ASSEMBLYAI_METADATA,
        warnings: [],
        failureReason: outcome.failureReason,
      };
    }

    console.log("[AssemblyAI] Transcript received:", {
      durationMs,
      length: outcome.text.length,
    });
    return {
      rawTranscript: outcome.text || null,
      metadata: { ...ASSEMBLYAI_METADATA, transcriptionDurationMs: durationMs },
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
