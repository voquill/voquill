import { convertFloat32ToPCM16 } from "@voquill/voice-ai";
import { WebSocketTranscriptionSession } from "./websocket-transcription-session";

export class AssemblyAITranscriptionSession extends WebSocketTranscriptionSession {
  readonly name = "AssemblyAI";
  protected readonly metadata = {
    inferenceDevice: "API • AssemblyAI (Streaming)",
    transcriptionMode: "api",
  } as const;
  protected readonly chunking = { minDurationMs: 50, maxDurationMs: 100 };
  protected readonly closeCompletesFinalize = true;
  private finalTranscript = "";
  private currentTurn = 0;
  private unfinishedTurn = "";

  constructor(private readonly apiKey: string) {
    super();
  }

  protected async openSocket(sampleRate: number): Promise<WebSocket> {
    return new WebSocket(
      `wss://streaming.assemblyai.com/v3/ws?sample_rate=${sampleRate}&token=${this.apiKey}`,
    );
  }

  protected encodeAudio(samples: Float32Array): ArrayBuffer {
    return convertFloat32ToPCM16(samples);
  }

  protected handleMessage(data: unknown): void {
    const message = JSON.parse(String(data));
    if (message.type === "Turn" && message.end_of_turn) {
      const turnTranscript: string = message.transcript || "";
      this.finalTranscript +=
        (this.finalTranscript ? " " : "") + turnTranscript;
      this.emitInterim(turnTranscript);
      if (this.currentTurn === message.turn_order) {
        this.unfinishedTurn = "";
      }
    } else if (message.type === "Turn") {
      if (this.currentTurn !== message.turn_order) {
        this.currentTurn = message.turn_order;
        this.unfinishedTurn = message.transcript;
      }
    } else if (message.type === "Termination") {
      this.complete();
    } else if (message.error) {
      this.fail(`AssemblyAI error: ${message.error}`);
    }
  }

  protected sendFinalizeRequest(): void {
    this.send(JSON.stringify({ type: "Terminate" }));
  }

  protected getFinalizeTimeoutMs(): number {
    return 2_000;
  }

  protected buildResult() {
    const text = [this.finalTranscript, this.unfinishedTurn]
      .filter(Boolean)
      .join(" ");
    return { rawTranscript: text || null };
  }
}
