import {
  AzureStreamingSession,
  createAzureStreamingSession,
} from "@voquill/voice-ai";
import { getAppState } from "../store";
import { TranscriptionSessionResult } from "../types/transcription-session.types";
import {
  buildLocalizedTranscriptionPrompt,
  collectDictionaryEntries,
} from "../utils/prompt.utils";
import { loadMyEffectiveDictationLanguage } from "../utils/user.utils";
import { PushStreamTranscriptionSession } from "./push-stream-transcription-session";
import { STREAM_CONNECT_TIMEOUT_MS } from "../utils/websocket.utils";

export class AzureTranscriptionSession extends PushStreamTranscriptionSession<AzureStreamingSession> {
  readonly name = "Azure";
  protected readonly metadata = {
    inferenceDevice: "API • Azure (Streaming)",
    transcriptionMode: "api",
  } as const;
  protected readonly connectTimeoutMs = STREAM_CONNECT_TIMEOUT_MS;

  constructor(
    private readonly subscriptionKey: string,
    private readonly region: string,
  ) {
    super();
  }

  protected async createStream(
    sampleRate: number,
  ): Promise<AzureStreamingSession> {
    const state = getAppState();
    const language = await loadMyEffectiveDictationLanguage(state);
    const prompt = buildLocalizedTranscriptionPrompt({
      entries: collectDictionaryEntries(state),
      dictationLanguage: language,
      state,
    });
    return await createAzureStreamingSession({
      subscriptionKey: this.subscriptionKey,
      region: this.region,
      sampleRate,
      language,
      prompt: prompt || undefined,
    });
  }

  protected async finishStream(
    stream: AzureStreamingSession,
  ): Promise<TranscriptionSessionResult> {
    const canceledBefore = stream.getError();
    if (canceledBefore) {
      return this.failure(`Azure recognition canceled: ${canceledBefore}`);
    }

    const startedAt = Date.now();
    const transcript = await stream.finalize();
    const canceledDuring = stream.getError();
    if (canceledDuring) {
      return this.failure(`Azure recognition canceled: ${canceledDuring}`);
    }

    return {
      rawTranscript: transcript || null,
      metadata: {
        ...this.metadata,
        transcriptionDurationMs: Date.now() - startedAt,
      },
      warnings: [],
    };
  }
}
