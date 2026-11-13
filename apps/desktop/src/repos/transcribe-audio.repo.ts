import { invokeHandler } from "@voquill/functions";
import { Nullable } from "@voquill/types";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import { batchAsync } from "@voquill/utilities";
import {
  aldeaTranscribeAudio,
  azureTranscribeRecording,
  deepgramTranscribeAudio,
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
} from "../utils/audio.utils";
import { invokeEnterprise } from "../utils/enterprise.utils";
import { getLocalTranscriptionSidecarManager } from "../sidecars";
import {
  getTranscriptionSidecarDeviceId,
  isGpuPreferredTranscriptionDevice,
  type LocalWhisperModel,
  normalizeLocalWhisperModel,
} from "../utils/local-transcription.utils";
import {
  abortable,
  abortableDelay,
  createAbortError,
} from "../utils/abort.utils";
import { AUTO_LANGUAGE } from "../utils/language.utils";
import { getLogger } from "../utils/log.utils";
import {
  getNewServerIdToken,
  getNewServerWebSocketUrl,
} from "../utils/new-server.utils";
import { openaiCompatibleTranscribeAudio } from "../utils/openai-compatible-transcribe.utils";
import { collectDictionaryEntries } from "../utils/prompt.utils";
import { speachesTranscribeAudio } from "../utils/speaches.utils";
import {
  getTranscriptionProcessingTimeoutMs,
  mergeTranscriptions,
  splitAudioTranscription,
} from "../utils/transcribe.utils";
import {
  closeSocket,
  STREAM_CONNECT_TIMEOUT_MS,
  waitForUploadDrain,
} from "../utils/websocket.utils";
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
  signal?: AbortSignal;
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
  /** Repos that can cancel their request should; callers stop waiting regardless. */
  signal?: AbortSignal;
};

export abstract class BaseTranscribeAudioRepo extends BaseRepo {
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
   * Transcribes audio, automatically splitting long audio into segments
   * and merging the results.
   */
  async transcribeAudio(
    input: TranscribeAudioInput,
  ): Promise<TranscribeAudioOutput> {
    const normalizedSamples = normalizeSamples(input.samples);
    const floatSamples = ensureFloat32Array(normalizedSamples);

    if (floatSamples.length === 0) {
      return { text: "", metadata: null };
    }

    const segmentDurationSec = this.getSegmentDurationSec();
    const segmentSampleCount = Math.floor(
      input.sampleRate * segmentDurationSec,
    );

    const transcribeSegment = (samples: Float32Array) =>
      abortable(
        this.transcribeSegment({
          samples,
          sampleRate: input.sampleRate,
          prompt: input.prompt,
          language: input.language,
          signal: input.signal,
        }),
        input.signal,
      );

    // If audio fits in a single segment, transcribe directly
    if (floatSamples.length <= segmentSampleCount) {
      return transcribeSegment(floatSamples);
    }

    // Split into overlapping segments
    const segments = splitAudioTranscription({
      sampleRate: input.sampleRate,
      samples: floatSamples,
      segmentDurationSec,
      overlapDurationSec: this.getOverlapDurationSec(),
    });

    // Create promise factories for batched execution
    const transcriptionTasks = segments.map(
      (segmentSamples) => () => transcribeSegment(segmentSamples),
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

const ASSEMBLYAI_API_URL = "https://api.assemblyai.com/v2";
const ASSEMBLYAI_POLL_INTERVAL_MS = 1_000;

type AssemblyAITranscriptResponse = {
  id: string;
  status: "queued" | "processing" | "completed" | "error";
  text?: string | null;
  error?: string;
};

export class AssemblyAITranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;

  constructor(apiKey: string) {
    super();
    this.apiKey = apiKey;
  }

  protected getSegmentDurationSec(): number {
    return 600;
  }

  protected getOverlapDurationSec(): number {
    return 5;
  }

  protected getBatchChunkCount(): number {
    return 2;
  }

  private async request<T>(
    path: string,
    init: RequestInit,
    signal: AbortSignal | undefined,
  ): Promise<T> {
    const response = await tauriFetch(`${ASSEMBLYAI_API_URL}${path}`, {
      ...init,
      headers: { authorization: this.apiKey, ...init.headers },
      signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      throw new Error(
        `AssemblyAI ${path} failed: ${response.status} ${detail}`,
      );
    }
    return (await response.json()) as T;
  }

  protected async transcribeSegment(
    input: TranscribeSegmentInput,
  ): Promise<TranscribeAudioOutput> {
    const { upload_url } = await this.request<{ upload_url: string }>(
      "/upload",
      {
        method: "POST",
        headers: { "content-type": "application/octet-stream" },
        body: buildWaveFile(input.samples, input.sampleRate),
      },
      input.signal,
    );
    const deadline =
      Date.now() +
      getTranscriptionProcessingTimeoutMs(
        (input.samples.length / input.sampleRate) * 1000,
      );

    const language =
      input.language && input.language !== AUTO_LANGUAGE
        ? { language_code: input.language }
        : { language_detection: true };
    let transcript = await this.request<AssemblyAITranscriptResponse>(
      "/transcript",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ audio_url: upload_url, ...language }),
      },
      input.signal,
    );

    while (
      transcript.status === "queued" ||
      transcript.status === "processing"
    ) {
      if (Date.now() > deadline) {
        throw new Error("AssemblyAI transcription timed out");
      }
      await abortableDelay(ASSEMBLYAI_POLL_INTERVAL_MS, input.signal);
      transcript = await this.request<AssemblyAITranscriptResponse>(
        `/transcript/${transcript.id}`,
        { method: "GET" },
        input.signal,
      );
    }

    if (transcript.status === "error") {
      throw new Error(`AssemblyAI transcription failed: ${transcript.error}`);
    }

    return {
      text: transcript.text ?? "",
      metadata: {
        inferenceDevice: "API • AssemblyAI",
        modelSize: null,
        transcriptionMode: "api",
      },
    };
  }
}

export class DeepgramTranscribeAudioRepo extends BaseTranscribeAudioRepo {
  private apiKey: string;
  private model: string;

  constructor(apiKey: string, model: string | null) {
    super();
    this.apiKey = apiKey;
    this.model = model ?? "nova-3";
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

    const { text: transcript } = await deepgramTranscribeAudio({
      apiKey: this.apiKey,
      model: this.model,
      blob: wavBuffer,
      ext: "wav",
      language: input.language,
    });

    return {
      text: transcript,
      metadata: {
        inferenceDevice: "API • Deepgram",
        modelSize: this.model,
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

  // Continuous recognition handles long audio; segments only bound memory.
  protected getSegmentDurationSec(): number {
    return 300;
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
    const { text: transcript } = await azureTranscribeRecording({
      subscriptionKey: this.azureSubscriptionKey,
      region: this.azureRegion,
      samples: input.samples,
      sampleRate: input.sampleRate,
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
    const audioDurationMs = (input.samples.length / input.sampleRate) * 1000;

    return new Promise((resolve, reject) => {
      const ws = new WebSocket(getNewServerWebSocketUrl("/v1/transcribe-raw"));
      const uploadWatch = new AbortController();
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      let lastMessageAt = 0;

      const setTimer = (timeoutMs: number, message: string) => {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => fail(new Error(message)), timeoutMs);
      };

      const finish = () => {
        settled = true;
        if (timer) clearTimeout(timer);
        uploadWatch.abort();
        input.signal?.removeEventListener("abort", onAbort);
        closeSocket(ws);
      };
      const fail = (error: Error) => {
        if (settled) return;
        finish();
        reject(error);
      };
      const onAbort = () => fail(createAbortError());
      input.signal?.addEventListener("abort", onAbort, { once: true });

      setTimer(
        STREAM_CONNECT_TIMEOUT_MS,
        `Server not ready within ${STREAM_CONNECT_TIMEOUT_MS / 1000}s`,
      );

      ws.onopen = async () => {
        try {
          const idToken = await getNewServerIdToken();
          ws.send(JSON.stringify({ type: "auth", idToken }));
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onmessage = (event) => {
        lastMessageAt = Date.now();
        try {
          const msg = JSON.parse(event.data);

          if (msg.type === "error") {
            fail(new Error(`${msg.code}: ${msg.message}`));
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
              }),
            );
            return;
          }

          if (msg.type === "ready") {
            if (timer) clearTimeout(timer);
            ws.send(input.samples);
            ws.send(JSON.stringify({ type: "finalize" }));
            waitForUploadDrain({
              ws,
              armed: false,
              getLastMessageAt: () => lastMessageAt,
              signal: uploadWatch.signal,
            }).then(() => {
              if (settled) return;
              const processingTimeoutMs =
                getTranscriptionProcessingTimeoutMs(audioDurationMs);
              setTimer(
                processingTimeoutMs,
                `Server did not return a transcript within ${Math.round(processingTimeoutMs / 1000)}s of receiving the audio`,
              );
            }, fail);
            return;
          }

          if (msg.type === "transcript") {
            if (settled) return;
            finish();
            resolve({
              text: msg.text,
              metadata: {
                transcriptionMode: "cloud",
              },
            });
            return;
          }
        } catch (err) {
          fail(err instanceof Error ? err : new Error(String(err)));
        }
      };

      ws.onerror = () => {
        fail(new Error("WebSocket error"));
      };

      ws.onclose = () => {
        fail(new Error("Connection closed unexpectedly"));
      };
    });
  }
}
