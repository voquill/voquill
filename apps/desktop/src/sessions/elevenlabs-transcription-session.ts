import { convertFloat32ToBase64PCM16 } from "@repo/voice-ai";
import { listen, UnlistenFn } from "@tauri-apps/api/event";
import {
  StopRecordingResponse,
  TranscriptionSession,
  TranscriptionSessionResult,
} from "../types/transcription-session.types";

type ElevenLabsStreamingSession = {
  finalize: () => Promise<string>;
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
): Promise<ElevenLabsStreamingSession> => {
  const sampleRate = SUPPORTED_SAMPLE_RATES.includes(inputSampleRate)
    ? inputSampleRate
    : getClosestSupportedSampleRate(inputSampleRate);

  if (sampleRate !== inputSampleRate) {
    console.warn(
      `[ElevenLabs WebSocket] Sample rate ${inputSampleRate} not supported, using ${sampleRate}. Audio may be distorted.`,
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

  const token = await getElevenLabsToken(apiKey);
  console.log("[ElevenLabs WebSocket] Got single-use token");

  return new Promise((resolve, reject) => {
    let ws: WebSocket | null = null;
    let unlisten: UnlistenFn | null = null;
    let finalTranscript = "";
    let partialTranscript = "";
    let isFinalized = false;
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
      if (unlisten) {
        unlisten();
        unlisten = null;
      }
      if (ws && ws.readyState !== WebSocket.CLOSED) {
        ws.close();
        ws = null;
      }
      resetBuffers();
    };

    let finalizeResolver: ((text: string) => void) | null = null;
    let finalizeTimeout: ReturnType<typeof setTimeout> | null = null;

    const finalize = (): Promise<string> => {
      return new Promise((resolveFinalize) => {
        console.log(
          "[ElevenLabs WebSocket] Finalize called, isFinalized:",
          isFinalized,
          "ws state:",
          ws?.readyState,
        );
        if (isFinalized) {
          console.log(
            "[ElevenLabs WebSocket] Already finalized, returning transcript",
          );
          resolveFinalize(getText());
          return;
        }

        isFinalized = true;
        finalizeResolver = resolveFinalize;

        flushPendingSamples(true);
        console.log(
          "[ElevenLabs WebSocket] Total chunks sent:",
          sentChunkCount,
          "- waiting for final transcript...",
        );

        if (ws && ws.readyState === WebSocket.OPEN) {
          finalizeTimeout = setTimeout(() => {
            console.log(
              "[ElevenLabs WebSocket] Timeout waiting for final transcript:",
              getText(),
            );
            cleanup();
            if (finalizeResolver) {
              finalizeResolver(getText());
              finalizeResolver = null;
            }
          }, 6000);
        } else {
          cleanup();
          resolveFinalize(getText());
        }
      });
    };

    const completeFinalize = () => {
      if (finalizeTimeout) {
        clearTimeout(finalizeTimeout);
        finalizeTimeout = null;
      }
      if (finalizeResolver) {
        console.log(
          "[ElevenLabs WebSocket] Completing finalize with transcript:",
          getText(),
        );
        cleanup();
        finalizeResolver(getText());
        finalizeResolver = null;
      }
    };

    const audioFormat = `pcm_${sampleRate}`;
    const wsUrl = `${ELEVENLABS_WS_URL}?token=${encodeURIComponent(token)}&model_id=scribe_v2_realtime&audio_format=${audioFormat}&commit_strategy=vad`;
    console.log(
      "[ElevenLabs WebSocket] Connecting to:",
      wsUrl.replace(token, "***"),
    );
    ws = new WebSocket(wsUrl);

    ws.onopen = async () => {
      console.log("[ElevenLabs WebSocket] Connected");

      try {
        console.log(
          "[ElevenLabs WebSocket] Setting up audio_chunk listener...",
        );
        unlisten = await listen<{ samples: number[] }>(
          "audio_chunk",
          (event) => {
            receivedChunkCount++;
            if (receivedChunkCount <= 3 || receivedChunkCount % 10 === 0) {
              console.log(
                `[ElevenLabs WebSocket] Received chunk #${receivedChunkCount}, samples:`,
                event.payload.samples.length,
              );
            }
            if (ws && ws.readyState === WebSocket.OPEN && !isFinalized) {
              try {
                const typedChunk =
                  event.payload.samples instanceof Float32Array
                    ? event.payload.samples
                    : Float32Array.from(event.payload.samples);
                pendingChunks.push(typedChunk);
                pendingSampleCount += typedChunk.length;
                flushPendingSamples(false);
              } catch (error) {
                console.error(
                  "[ElevenLabs WebSocket] Error sending audio chunk:",
                  error,
                );
              }
            }
          },
        );

        console.log("[ElevenLabs WebSocket] Session ready, listener attached");
        resolve({ finalize, cleanup });
      } catch (error) {
        console.error(
          "[ElevenLabs WebSocket] Error setting up listener:",
          error,
        );
        cleanup();
        reject(error);
      }
    };

    ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        const messageType = data.message_type || data.type;
        console.log(
          "[ElevenLabs WebSocket] Received message:",
          messageType,
          data,
        );

        if (messageType === "committed_transcript") {
          finalTranscript += (finalTranscript ? " " : "") + (data.text || "");
          partialTranscript = "";
          console.log(
            "[ElevenLabs WebSocket] Committed transcript received:",
            finalTranscript.substring(0, 100),
          );
          if (isFinalized) {
            completeFinalize();
          }
        } else if (messageType === "partial_transcript") {
          partialTranscript = data.text || "";
        } else if (messageType === "session_started") {
          console.log("[ElevenLabs WebSocket] Session started:", data);
        } else if (messageType === "error" || messageType === "input_error") {
          console.error("[ElevenLabs WebSocket] Error from server:", data);
        }
      } catch (error) {
        console.error("[ElevenLabs WebSocket] Error parsing message:", error);
      }
    };

    ws.onerror = (error) => {
      console.error("[ElevenLabs WebSocket] WebSocket error:", error);
      cleanup();
      reject(new Error("WebSocket connection failed"));
    };

    ws.onclose = (event) => {
      console.log("[ElevenLabs WebSocket] WebSocket closed:", {
        code: event.code,
        reason: event.reason,
      });
      cleanup();
    };
  });
};

export class ElevenLabsTranscriptionSession implements TranscriptionSession {
  private session: ElevenLabsStreamingSession | null = null;
  private apiKey: string;

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  async onRecordingStart(sampleRate: number): Promise<void> {
    try {
      console.log("[ElevenLabs] Starting streaming session...");
      this.session = await startElevenLabsStreaming(this.apiKey, sampleRate);
      console.log("[ElevenLabs] Streaming session started successfully");
    } catch (error) {
      console.error("[ElevenLabs] Failed to start streaming:", error);
    }
  }

  async finalize(
    _audio: StopRecordingResponse,
  ): Promise<TranscriptionSessionResult> {
    if (!this.session) {
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • ElevenLabs (Streaming)",
          transcriptionMode: "api",
        },
        warnings: ["ElevenLabs streaming session was not established"],
      };
    }

    try {
      console.log("[ElevenLabs] Finalizing streaming session...");
      const finalizeStart = performance.now();
      const transcript = await this.session.finalize();
      const durationMs = Math.round(performance.now() - finalizeStart);

      console.log("[ElevenLabs] Transcript timing:", { durationMs });
      console.log("[ElevenLabs] Received transcript:", {
        length: transcript?.length ?? 0,
        preview:
          transcript?.substring(0, 50) +
          (transcript && transcript.length > 50 ? "..." : ""),
      });

      return {
        rawTranscript: transcript || null,
        metadata: {
          inferenceDevice: "API • ElevenLabs (Streaming)",
          transcriptionMode: "api",
          transcriptionDurationMs: durationMs,
        },
        warnings: [],
      };
    } catch (error) {
      console.error("[ElevenLabs] Failed to finalize session:", error);
      return {
        rawTranscript: null,
        metadata: {
          inferenceDevice: "API • ElevenLabs (Streaming)",
          transcriptionMode: "api",
        },
        warnings: [
          `ElevenLabs finalization failed: ${error instanceof Error ? error.message : "Unknown error"}`,
        ],
      };
    }
  }

  cleanup(): void {
    if (this.session) {
      this.session.cleanup();
      this.session = null;
    }
  }
}
