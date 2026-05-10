import { invokeHandler } from "@voquill/functions";
import { Nullable } from "@voquill/types";
import { batchAsync } from "@voquill/utilities";
import {
  aldeaTranscribeAudio,
  azureTranscribeAudio,
  elevenlabsTranscribeAudio,
  geminiTranscribeAudio,
  GeminiTranscriptionModel,
  groqTranscribeAudio,
  openaiTranscribeAudio,
  OpenAITranscriptionModel,
  TranscriptionModel,
  xaiTranscribeAudio,
  XaiTranscriptionModel,
} from "@voquill/voice-ai";
import { getAppState } from "../store";
import { DEFAULT_MODEL_SIZE, TranscriptionMode } from "../types/ai.types";
import { AudioSamples } from "../types/audio.types";
import {
  buildWaveFile,
  ensureFloat32Array,
  normalizeSamples,
  resampleTo16kHz,
} from "../utils/audio.utils";
import { getEffectiveAuth } from "../utils/auth.utils";
import { invokeEnterprise } from "../utils/enterprise.utils";
import { getLocalTranscriptionSidecarManager } from "../sidecars";
import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  type LocalWhisperModel,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import { NEW_SERVER_URL } from "../utils/new-server.utils";
import { openaiCompatibleTranscribeAudio } from "../utils/openai-compatible-transcribe.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import { speachesTranscribeAudio } from "../utils/speaches.utils";
import {
  mergeTranscriptions,
  splitAudioTranscription,
} from "../utils/transcribe.utils";
import { BaseRepo } from "./base.repo";

type TranscriptionOptionsPayload = {
  model: LocalWhisperModel;
  preferGpu: boolean;
  deviceId?: string;
};

export type TranscribeAudioMetadata = {
  inferenceDevice?: Nullable<string>;
  modelSize?: Nullable<string>;
  transcriptionMode?: Nullable<TranscriptionMode>;
};

export type TranscribeAudioInput = {
  samples: AudioSamples;
  sampleRate: number;
  prompt?: Nullable<string>;
  language?: string;
};

export type TranscribeAudioOutput = {
  text: string;
  metadata?: Nullable<TranscribeAudioMetadata>;
};

export type TranscribeSegmentInput = {
  samples: Float32Array;
  sampleRate: number;
  prompt?: Nullable<string>;
  language?: string;
};

export abstract class BaseTranscribeAudioRepo extends BaseRepo {
  supportsPromptHints(): boolean {
    return false;
  }

  /**
   * Maximum duration in seconds for a single audio segment.
   * Override in child classes based on provider limits.
   */
  protected abstract getSegmentDurationSec(): number;

  /**
   * Overlap duration in seconds between consecutive segments.
   * Helps ensure transcription continuity at segment boundaries.
   */
  protected abstract getOverlapDurationSec(): number;

  /**
   * Number of concurrent transcription requests to run.
   * API providers may allow more parallelism, local inference typically 1.
   */
  protected abstract getBatchChunkCount(): number;

  /**
   * Internal method to transcribe a single audio segment.
   * Implemented by child classes with provider-specific logic.
   */
  protected abstract transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput>;

  /**
   * Whether to resample audio to 16kHz before transcription.
   * API-based repos benefit from smaller payloads; local sidecar resamples internally.
   */
  protected shouldResampleTo16kHz(): boolean {
    return true;
  }

  /**
   * Transcribes audio, automatically splitting long audio into segments
   * and merging the results.
   */
  async transcribeAudio(
    input: TranscribeAudioInput,
  ): Promise<TranscribeAudioOutput> {
    const normalizedSamples = normalizeSamples(input.samples);
    let floatSamples = ensureFloat32Array(normalizedSamples);
    let sampleRate = input.sampleRate;

    if (floatSamples.length === 0) {
      return { text: "", metadata: null };
    }

    if (this.shouldResampleTo16kHz() && sampleRate !== 16000) {
      floatSamples = resampleTo16kHz(floatSamples, sampleRate);
      sampleRate = 16000;
    }

    const segmentDurationSec = this.getSegmentDurationSec();
    const segmentSampleCount = Math.floor(
      sampleRate * segmentDurationSec,
    );

    // If audio fits in a single segment, transcribe directly
    if (floatSamples.length <= segmentSampleCount) {
      return this.transcribeSegment({
        samples: floatSamples,
        sampleRate,
        prompt: input.prompt,
        language: input.language,
      });
    }

    // Split into overlapping segments
    const segments = splitAudioTranscription({
      sampleRate,
      samples: floatSamples,
      segmentDurationSec,
      overlapDurationSec: this.getOverlapDurationSec(),
    });

    // Create promise factories for batched execution
    const transcriptionTasks = segments.map(
      (segmentSamples) => () =>
        this.transcribeSegment({
          samples: segmentSamples,
          sampleRate,
          prompt: input.prompt,
          language: input.language,
        }),
    );

    // Execute in batches
    const results = await batchAsync(
      this.getBatchChunkCount(),
      transcriptionTasks,
    );

    // Merge transcription texts
    const transcriptionTexts = results.map((r) => r.text);
    const mergedText = mergeTranscriptions(transcriptionTexts);

    // Use metadata from first result (all segments use same provider/device)
    const metadata = results[0]?.metadata ?? null;

    return {
      text: mergedText,
      metadata,
    };
  }
}

export class LocalTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  override supportsPromptHints(): boolean {
    return true;
  }

  // Local sidecar resamples internally in Rust; skip JS-side resampling.
  protected override shouldResampleTo16kHz(): boolean {
    return false;
  }

  // Local whisper can handle longer segments, but 60s is a safe default
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Local inference is single-threaded, process one at a time
  protected getBatchChunkCount(): number {
    return 1;
  }

  private resolveTranscriptionOptions(): TranscriptionOptionsPayload {
    const state = getAppState();
    const { device, modelSize } = state.settings.aiTranscription;
    getLogger().info("transcribing with", device, modelSize);

    return {
      model: normalizeLocalWhisperModel(modelSize || DEFAULT_MODEL_SIZE),
      preferGpu: isGpuPreferredTranscriptionDevice(device),
      deviceId: getTranscriptionSidecarDeviceId(device),
    };
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const options = this.resolveTranscriptionOptions();
    const sidecarManager = getLocalTranscriptionSidecarManager();
    const output = await sidecarManager.transcribe({
      model: options.model,
      preferGpu: options.preferGpu,
      samples: input.samples,
      sampleRate: input.sampleRate,
      initialPrompt: input.prompt ?? undefined,
      language: input.language,
      deviceId: options.deviceId,
    });

    return {
      text: output.text,
      metadata: {
        inferenceDevice: output.inferenceDevice,
        modelSize: output.model,
        transcriptionMode: "local",
      },
    };
  }
}

export class CloudTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  // Cloud uses Groq under the hood, 60s segments are safe
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Allow some parallelism for cloud requests
  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const bytes = new Uint8Array(wavBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }

    const audioBase64 = btoa(binary);
    const response = await invokeHandler("ai/transcribeAudio", {
      prompt: input.prompt,
      audioBase64,
      audioMimeType: "audio/wav",
      language: input.language,
    });

    return {
      text: response.text,
      metadata: {
        transcriptionMode: "cloud",
      },
    };
  }
}

export class GroqTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private groqApiKey: string;
  private model: TranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.groqApiKey = apiKey;
    this.model = (model as TranscriptionModel) ?? "whisper-large-v3-turbo";
  }

  override supportsPromptHints(): boolean {
    return true;
  }

  // Groq has 25MB limit, 60s segments are well within that
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Groq can handle parallel requests
  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await groqTranscribeAudio({
      apiKey: this.groqApiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Groq",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class OpenAITranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private openaiApiKey: string;
  private model: OpenAITranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.openaiApiKey = apiKey;
    this.model = (model as OpenAITranscriptionModel) ?? "whisper-1";
  }

  override supportsPromptHints(): boolean {
    return true;
  }

  // OpenAI has 25MB limit, 60s segments are well within that
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // OpenAI can handle parallel requests
  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await openaiTranscribeAudio({
      apiKey: this.openaiApiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • OpenAI",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class AldeaTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private aldeaApiKey: string;

  constructor(apiKey: string) {
    super();
    this.aldeaApiKey = apiKey;
  }

  // Conservative segment duration for Aldea
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Allow some parallelism for API requests
  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await aldeaTranscribeAudio({
      apiKey: this.aldeaApiKey,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Aldea",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class ElevenLabsTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await elevenlabsTranscribeAudio({
      apiKey: this.apiKey,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • ElevenLabs",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class XaiTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;
  private model: XaiTranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = (model as XaiTranscriptionModel) ?? "grok-stt";
  }

  override supportsPromptHints(): boolean {
    return true;
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await xaiTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Grok",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class AzureTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private azureSubscriptionKey: string;
  private azureRegion: string;

  constructor(subscriptionKey: string, region: string) {
    super();
    this.azureSubscriptionKey = subscriptionKey;
    this.azureRegion = region;
  }

  // Azure supports up to 30MB, 60s segments are safe
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  // Azure can handle parallel requests
  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await azureTranscribeAudio({
      subscriptionKey: this.azureSubscriptionKey,
      region: this.azureRegion,
      blob: wavBuffer,
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Azure",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class GeminiTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private geminiApiKey: string;
  private model: GeminiTranscriptionModel;

  constructor(apiKey: string, model: string | null) {
    super();
    this.geminiApiKey = apiKey;
    this.model = (model as GeminiTranscriptionModel) ?? "gemini-2.5-flash";
  }

  override supportsPromptHints(): boolean {
    return true;
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await geminiTranscribeAudio({
      apiKey: this.geminiApiKey,
      model: this.model,
      blob: wavBuffer,
      mimeType: "audio/wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Gemini",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class SpeachesTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private baseUrl: string;
  private model: string;

  constructor(baseUrl: string, model: string) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
  }

  override supportsPromptHints(): boolean {
    return true;
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await speachesTranscribeAudio({
      baseUrl: this.baseUrl,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Speaches",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class OpenAICompatibleTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private baseUrl: string;
  private model: string;
  private apiKey?: string;

  constructor(baseUrl: string, model: string, apiKey?: string) {
    super();
    this.baseUrl = baseUrl;
    this.model = model;
    this.apiKey = apiKey;
  }

  override supportsPromptHints(): boolean {
    return true;
  }

  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const { text: transcript } = await openaiCompatibleTranscribeAudio({
      baseUrl: this.baseUrl,
      model: this.model,
      apiKey: this.apiKey,
      blob: wavBuffer,
      ext: "wav",
      prompt: input.prompt ?? undefined,
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • OpenAI Compatible",
        modelSize: this.model,
        transcriptionMode: "api",
      },
    };
  }
}

export class EnterpriseTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  protected getSegmentDurationSec(): number {
    return 60;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 3;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wavBuffer = buildWaveFile(input.samples, input.sampleRate);

    const bytes = new Uint8Array(wavBuffer);
    let binary = "";
    for (let i = 0; i < bytes.length; i++) {
      binary += String.fromCharCode(bytes[i]!);
    }

    const audioBase64 = btoa(binary);
    const response = await invokeEnterprise("ai/transcribeAudio", {
      prompt: input.prompt,
      audioBase64,
      audioMimeType: "audio/wav",
      language: input.language,
    });

    return {
      text: response.text,
      metadata: {
        transcriptionMode: "cloud",
      },
    };
  }
}

export class NewServerTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  protected getSegmentDurationSec(): number {
    return 300;
  }

  protected getOverlapDurationSec(): number {
    return 0;
  }

  protected getBatchChunkCount(): number {
    return 1;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const wsUrl = NEW_SERVER_URL.replace(/^http/, "ws") + "/v1/transcribe-raw";

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(wsUrl);
      let resolved = false;

      const cleanup = () => {
        ws.close();
      };

      const settle = (
        fn: typeof resolve | typeof reject,
        value: TranscribeAudioOutput | Error,
      ) => {
        if (resolved) return;
        resolved = true;
        (fn as (v: unknown) => void)(value);
      };

      ws.onopen = async () => {
        try {
          const auth = getEffectiveAuth();
          const user = auth.currentUser;
          if (!user) {
            settle(reject, new Error("Not authenticated"));
            cleanup();
            return;
          }
          const idToken = await user.getIdToken();
          ws.send(JSON.stringify({ type: "auth", idToken }));
        } catch (err) {
          settle(reject, err instanceof Error ? err : new Error(String(err)));
          cleanup();
        }
      };

      ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "error") {
            settle(reject, new Error(`${msg.code}: ${msg.message}`));
            cleanup();
            return;
          }

          if (msg.type === "authenticated") {
            const state = getAppState();
            const entries = collectDictionaryEntries(state);
            ws.send(
              JSON.stringify({
                type: "config",
                sampleRate: input.sampleRate,
                glossary: entries.sources,
                language: input.language,
                prompt: input.prompt ?? undefined,
              }),
            );
            return;
          }

          if (msg.type === "ready") {
            ws.send(input.samples.buffer as ArrayBuffer);
            ws.send(JSON.stringify({ type: "finalize" }));
            return;
          }

          if (msg.type === "transcript") {
            settle(resolve, {
              text: msg.text,
              metadata: {
                transcriptionMode: "cloud",
              },
            });
            cleanup();
            return;
          }
        } catch (err) {
          settle(reject, err instanceof Error ? err : new Error(String(err)));
          cleanup();
        }
      };

      ws.onerror = () => {
        settle(reject, new Error("WebSocket error"));
        cleanup();
      };

      ws.onclose = () => {
        settle(reject, new Error("Connection closed unexpectedly"));
      };
    });
  }
}
