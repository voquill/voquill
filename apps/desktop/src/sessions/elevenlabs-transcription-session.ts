import { convertFloat32ToBase64PCM16 } from "@voquill/voice-ai";
import { WebSocketTranscriptionSession } from "./websocket-transcription-session";

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

const getElevenLabsToken = async (
  apiKey: string,
  signal: AbortSignal,
): Promise<string> => {
  const response = await fetch(ELEVENLABS_TOKEN_URL, {
    method: "POST",
    headers: {
      "xi-api-key": apiKey,
    },
    signal,
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

// Error message types from the realtime protocol; each one ends the stream.
// commit_throttled is included because a rejected final commit leaves the
// last audio uncommitted.
const FATAL_MESSAGE_TYPES = new Set([
  "error",
  "auth_error",
  "quota_exceeded",
  "rate_limited",
  "queue_overflow",
  "resource_exhausted",
  "session_time_limit_exceeded",
  "input_error",
  "chunk_size_exceeded",
  "transcriber_error",
  "unaccepted_terms",
  "commit_throttled",
]);

export class ElevenLabsTranscriptionSession extends WebSocketTranscriptionSession {
  readonly name = "ElevenLabs";
  protected readonly metadata = {
    inferenceDevice: "API • ElevenLabs (Streaming)",
    transcriptionMode: "api",
  } as const;
  protected readonly chunking = { minDurationMs: 20, maxDurationMs: 100 };
  protected readonly closeCompletesFinalize = false;
  private finalTranscript = "";
  private partialTranscript = "";
  private hasSentFinalCommit = false;

  constructor(private readonly apiKey: string) {
    super();
  }

  protected getStreamSampleRate(): number {
    return SUPPORTED_SAMPLE_RATES.includes(this.sampleRate)
      ? this.sampleRate
      : getClosestSupportedSampleRate(this.sampleRate);
  }

  protected transformAudio(samples: Float32Array): Float32Array {
    return resampleAudio(samples, this.sampleRate, this.getStreamSampleRate());
  }

  protected async openSocket(
    _sampleRate: number,
    signal: AbortSignal,
  ): Promise<WebSocket> {
    const token = await getElevenLabsToken(this.apiKey, signal);
    signal.throwIfAborted();
    const audioFormat = `pcm_${this.getStreamSampleRate()}`;
    return new WebSocket(
      `${ELEVENLABS_WS_URL}?token=${encodeURIComponent(token)}&model_id=scribe_v2_realtime&audio_format=${audioFormat}&commit_strategy=vad`,
    );
  }

  protected encodeAudio(samples: Float32Array, isFinal: boolean): string {
    if (isFinal) {
      this.hasSentFinalCommit = true;
    }
    return JSON.stringify({
      message_type: "input_audio_chunk",
      audio_base_64: convertFloat32ToBase64PCM16(samples),
      commit: isFinal,
      sample_rate: this.getStreamSampleRate(),
    });
  }

  protected handleMessage(data: unknown): void {
    const message = JSON.parse(String(data));
    const messageType: string = message.message_type || message.type || "";
    if (messageType === "committed_transcript") {
      const committedText: string = message.text || "";
      this.finalTranscript += (this.finalTranscript ? " " : "") + committedText;
      this.partialTranscript = "";
      this.emitInterim(committedText);
      this.complete();
    } else if (messageType === "partial_transcript") {
      this.partialTranscript = message.text || "";
    } else if (messageType === "insufficient_audio_activity") {
      // The final commit had no speech left to transcribe: a positive
      // acknowledgement that the committed text is complete.
      if (this.isFinalizing && !this.partialTranscript) {
        this.complete();
      }
    } else if (FATAL_MESSAGE_TYPES.has(messageType)) {
      this.fail(
        `ElevenLabs ${messageType}: ${message.error ?? message.message ?? "unknown"}`,
      );
    }
  }

  protected sendFinalizeRequest(): void {
    if (!this.hasSentFinalCommit) {
      this.sendFinalSilence();
    }
  }

  protected getFinalizeTimeoutMs(): number {
    return 6_000;
  }

  protected buildResult() {
    return { rawTranscript: this.finalTranscript || null };
  }
}
