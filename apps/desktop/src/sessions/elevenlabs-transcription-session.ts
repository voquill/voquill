import { convertFloat32ToBase64PCM16 } from "@voquill/voice-ai";
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

// Base64-encoded PCM16 inside JSON messages.
const BASE64_PCM16_BYTES = (2 * 4) / 3;

type ElevenLabsStreamingSession = {
  finalize: () => Promise<StreamingFinalizeOutcome>;
  cleanup: () => void;
};

const ELEVENLABS_WS_URL = "wss://api.elevenlabs.io/v1/speech-to-text/realtime";
const ELEVENLABS_TOKEN_URL =
  "https://api.elevenlabs.io/v1/single-use-token/realtime_scribe";

const SUPPORTED_SAMPLE_RATES = [8000, 16000, 22050, 24000, 44100, 48000];

const getClosestSupportedSampleRate = (sampleRate: number): number => {
  let closest = SUPPORTED_SAMPLE_RATES[0];
  let minDiff = Math.abs(sampleRate - closest);

  for (const supported of SUPPORTED_SAMPLE_RATES) {
    const diff = Math.abs(sampleRate - supported);
    if (diff < minDiff) {
      minDiff = diff;
      closest = supported;
    }
  }

  return closest;
};

const resampleAudio = (
  input: Float32Array,
  inputRate: number,
  outputRate: number,
): Float32Array => {
  if (inputRate === outputRate) return input;
  const ratio = inputRate / outputRate;
  const outputLength = Math.ceil(input.length / ratio);
  const output = new Float32Array(outputLength);
  for (let i = 0; i < outputLength; i++) {
    const srcIndex = i * ratio;
    const srcFloor = Math.floor(srcIndex);
    const frac = srcIndex - srcFloor;
    const a = input[srcFloor] ?? 0;
    const b = input[Math.min(srcFloor + 1, input.length - 1)] ?? 0;
    output[i] = a + frac * (b - a);
  }
  return output;
};

const getElevenLabsToken = async (apiKey: string): Promise<string> => {
  const response = await fetch(ELEVENLABS_TOKEN_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => "Unknown error");
    throw new Error(
      `Failed to get ElevenLabs token: ${response.status} ${errorText}`,
    );
  }

  const data = await response.json();
  return data.token;
};

const startElevenLabsStreaming = async (
  apiKey: string,
  inputSampleRate: number,
  onInterimResult?: (segment: string) => void,
): Promise<ElevenLabsStreamingSession> => {
  const sampleRate = SUPPORTED_SAMPLE_RATES.includes(inputSampleRate)
    ? inputSampleRate
    : getClosestSupportedSampleRate(inputSampleRate);

  const needsResample = sampleRate !== inputSampleRate;
  if (needsResample) {
    console.warn(
      `[ElevenLabs WebSocket] Sample rate ${inputSampleRate} not supported, resampling to ${sampleRate}.`,
    );
  }

  console.log("[ElevenLabs WebSocket] Starting with sample rate:", sampleRate);

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

  const relay = await AudioChunkRelay.start();
  let token: string;
  try {
    token = await getElevenLabsToken(apiKey);
  } catch (error) {
    relay.stop();
    throw error;
  }
  console.log("[ElevenLabs WebSocket] Got single-use token");

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let finalTranscript = "";
    let partialTranscript = "";
    let isFinalized = false;
    let failureReason: string | null = null;
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

    const sendAudioChunk = (chunk: Float32Array, commit: boolean) => {
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return;
      }

      try {
        const base64Audio = convertFloat32ToBase64PCM16(chunk);
        const message = JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: base64Audio,
          commit,
          sample_rate: sampleRate,
        });
        ws.send(message);
        sentChunkCount++;
        if (sentChunkCount <= 3 || sentChunkCount % 10 === 0) {
          const durationMs = (chunk.length / sampleRate) * 1000;
          console.log(
            `[ElevenLabs WebSocket] Sent chunk #${sentChunkCount} (${chunk.length} samples ~${durationMs.toFixed(1)} ms)`,
          );
        }
      } catch (error) {
        console.error("[ElevenLabs WebSocket] Error sending chunk:", error);
      }
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

        const isLastChunk = force && pendingSampleCount === 0;
        sendAudioChunk(chunk, isLastChunk);
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
      console.warn(`[ElevenLabs WebSocket] ${reason}`);
      settleFinalize({ failureReason: reason });
    };

    const finalize = (): Promise<StreamingFinalizeOutcome> => {
      return new Promise((resolveFinalize) => {
        console.log(
          "[ElevenLabs WebSocket] Finalize called, isFinalized:",
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

        if (!ws || ws.readyState !== WebSocket.OPEN) {
          fail("Connection closed before finalize");
          return;
        }

        flushPendingSamples(true);
        console.log(
          "[ElevenLabs WebSocket] Total chunks sent:",
          sentChunkCount,
          "- waiting for final transcript...",
        );

        const stalled = getStalledUploadFailure(
          ws,
          sampleRate * BASE64_PCM16_BYTES,
        );
        if (stalled) {
          fail(stalled);
          return;
        }

        finalizeTimeout = setTimeout(() => {
          fail("ElevenLabs did not commit the final transcript within 6s");
        }, 6000);
      });
    };

    const completeFinalize = () => {
      if (finalizeResolver && !failureReason) {
        console.log(
          "[ElevenLabs WebSocket] Completing finalize with transcript length:",
          getText().length,
        );
        settleFinalize({ text: getText() });
      }
    };

    const audioFormat = `pcm_${sampleRate}`;
    const wsUrl = `${ELEVENLABS_WS_URL}?token=${encodeURIComponent(token)}&model_id=scribe_v2_realtime&audio_format=${audioFormat}&commit_strategy=vad`;
    console.log("[ElevenLabs WebSocket] Connecting...");
    ws = new WebSocket(wsUrl);
    let isOpen = false;
    const connectTimeout = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `ElevenLabs connection not open within ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`,
        ),
      );
    }, STREAM_CONNECT_TIMEOUT_MS);

    ws.onopen = () => {
      isOpen = true;
      clearTimeout(connectTimeout);
      console.log("[ElevenLabs WebSocket] Connected, flushing buffered audio");
      relay.pipeTo((rawChunk) => {
        if (isFinalized) {
          return;
        }
        const typedChunk = needsResample
          ? resampleAudio(rawChunk, inputSampleRate, sampleRate)
          : rawChunk;
        pendingChunks.push(typedChunk);
        pendingSampleCount += typedChunk.length;
        flushPendingSamples(false);
      });
      resolve({ finalize, cleanup });
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const messageType: string = data.message_type || data.type || "";
        console.log("[ElevenLabs WebSocket] Received message:", messageType);

        if (messageType === "committed_transcript") {
          const committedText = data.text || "";
          finalTranscript += (finalTranscript ? " " : "") + committedText;
          partialTranscript = "";
          if (onInterimResult && committedText) {
            onInterimResult(committedText);
          }
          if (isFinalized) {
            completeFinalize();
          }
        } else if (messageType === "partial_transcript") {
          partialTranscript = data.text || "";
        } else if (messageType === "session_started") {
          console.log("[ElevenLabs WebSocket] Session started");
        } else if (messageType.includes("error")) {
          console.error("[ElevenLabs WebSocket] Error from server:", data);
          fail(
            `ElevenLabs ${messageType}: ${data.error ?? data.message ?? "unknown"}`,
          );
        }
      } catch (error) {
        console.error("[ElevenLabs WebSocket] Error parsing message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("[ElevenLabs WebSocket] WebSocket error:", error);
      if (!isOpen) {
        clearTimeout(connectTimeout);
        cleanup();
        reject(new Error("WebSocket connection failed"));
        return;
      }
      fail("WebSocket error");
    };

    ws.onclose = (event) => {
      console.log("[ElevenLabs WebSocket] WebSocket closed:", {
        code: event.code,
        reason: event.reason,
      });
      fail(
        getAbnormalCloseFailure(event) ??
          `Connection closed before the final transcript (code=${event.code}${event.reason ? `, reason=${event.reason}` : ""})`,
      );
      cleanup();
    };
  });
};

const ELEVENLABS_METADATA = {
  inferenceDevice: "API • ElevenLabs (Streaming)",
  transcriptionMode: "api",
} as const;

export class ElevenLabsTranscriptionSession implements TranscriptionSession {
  private session: ElevenLabsStreamingSession | null = null;
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
      console.log("[ElevenLabs] Starting streaming session...");
      this.session = await startElevenLabsStreaming(
        this.apiKey,
        sampleRate,
        this.interimCallback ?? undefined,
      );
      console.log("[ElevenLabs] Streaming session started successfully");
    } catch (error) {
      console.error("[ElevenLabs] Failed to start streaming:", error);
      this.startFailureReason = toErrorMessage(error);
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: ELEVENLABS_METADATA,
        warnings: [],
        failureReason: `ElevenLabs streaming session was not established${this.startFailureReason ? `: ${this.startFailureReason}` : ""}`,
      };
    }

    console.log("[ElevenLabs] Finalizing streaming session...");
    const finalizeStart = performance.now();
    const outcome = await this.session.finalize();
    const durationMs = Math.round(performance.now() - finalizeStart);
    if ("failureReason" in outcome) {
      return {
        rawTranscript: null,
        metadata: ELEVENLABS_METADATA,
        warnings: [],
        failureReason: outcome.failureReason,
      };
    }

    console.log("[ElevenLabs] Transcript received:", {
      durationMs,
      length: outcome.text.length,
    });
    return {
      rawTranscript: outcome.text || null,
      metadata: { ...ELEVENLABS_METADATA, transcriptionDurationMs: durationMs },
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
