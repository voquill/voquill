import { convertFloat32ToPCM16 } from "@voquill/voice-ai";
import { getAppState } from "../store";
import { buildDeepgramWebSocketUrl } from "../utils/deepgram.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { WebSocketTranscriptionSession } from "./websocket-transcription-session";

export class DeepgramTranscriptionSession extends WebSocketTranscriptionSession {
  readonly name = "Deepgram";
  protected readonly metadata = {
    inferenceDevice: "API • Deepgram (Streaming)",
    transcriptionMode: "api",
  } as const;
  protected readonly chunking = { minDurationMs: 20, maxDurationMs: 100 };
  protected readonly closeCompletesFinalize = true;
  private finalTranscript = "";
  private partialTranscript = "";

  constructor(private readonly apiKey: string) {
    super();
  }

  protected async openSocket(
    sampleRate: number,
    signal: AbortSignal,
  ): Promise<WebSocket> {
    const language = await loadMyEffectiveDictationLanguage(getAppState());
    signal.throwIfAborted();
    return new WebSocket(buildDeepgramWebSocketUrl({ sampleRate, language }), [
      "token",
      this.apiKey,
    ]);
  }

  protected encodeAudio(samples: Float32Array): ArrayBuffer {
    return convertFloat32ToPCM16(samples);
  }

  protected handleMessage(data: unknown): void {
    const message = JSON.parse(String(data));
    if (message.type === "Results") {
      const transcript: string =
        message.channel?.alternatives?.[0]?.transcript || "";
      if (message.is_final && transcript) {
        this.finalTranscript += (this.finalTranscript ? " " : "") + transcript;
        this.partialTranscript = "";
        this.emitInterim(transcript);
        if (message.speech_final) {
          this.complete();
        }
      } else if (transcript) {
        this.partialTranscript = transcript;
      }
    } else if (message.type === "Error" || message.error) {
      this.fail(
        `Deepgram error: ${message.description ?? message.message ?? message.error ?? "unknown"}`,
      );
    }
  }

  protected sendFinalizeRequest(): void {
    this.send(JSON.stringify({ type: "CloseStream" }));
  }

  protected getFinalizeTimeoutMs(): number {
    return 3_000;
  }

  protected buildResult() {
    const text = [this.finalTranscript, this.partialTranscript]
      .filter(Boolean)
      .join(" ");
    return { rawTranscript: text || null };
  }
}
