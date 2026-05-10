import { appDataDir, join } from "@tauri-apps/api/path";
import {
  LOCAL_WHISPER_MODELS,
  type LocalWhisperModel,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import type { ShellChildProcess } from "../utils/tauri-shell.utils";
import { BaseSidecar, type SidecarRuntime } from "./base.sidecar";
import { fetchWithTimeout, sleep, toErrorMessage } from "./sidecar.utils";

type SidecarMode = "cpu" | "gpu";

type SidecarHealthResponse = {
  status: string;
  mode: string;
};

type SidecarModelStatusResponse = {
  model: LocalWhisperModel;
  downloaded: boolean;
  valid: boolean;
  fileBytes: number | null;
  validationError: string | null;
};

type SidecarDownloadSnapshot = {
  jobId: string;
  model: LocalWhisperModel;
  status: "pending" | "running" | "completed" | "failed";
  bytesDownloaded: number;
  totalBytes: number | null;
  progress: number | null;
  error: string | null;
};

type SidecarTranscriptionResponse = {
  text: string;
  model: LocalWhisperModel;
  inferenceDevice: string;
  durationMs: number;
};

type SidecarCreateTranscriptionSessionResponse = {
  sessionId: string;
};

type SidecarAppendTranscriptionChunkResponse = {
  receivedSamples: number;
  bufferedSamples: number;
};

type SidecarDeleteTranscriptionSessionResponse = {
  deleted: boolean;
};

type SidecarDeviceResponse = {
  id: string;
  name: string;
};

type SidecarDevicesResponse = {
  devices: SidecarDeviceResponse[];
};

export type LocalSidecarModelStatus = SidecarModelStatusResponse;
export type LocalSidecarDownloadSnapshot = SidecarDownloadSnapshot;
export type LocalSidecarDevice = SidecarDeviceResponse & {
  mode: SidecarMode;
};

export type LocalSidecarTranscribeInput = {
  model: LocalWhisperModel;
  samples: number[] | Float32Array;
  sampleRate: number;
  language?: string;
  initialPrompt?: string;
  preferGpu: boolean;
  deviceId?: string;
};

export type LocalSidecarStreamingSessionInput = Omit<
  LocalSidecarTranscribeInput,
  "samples"
>;

export type LocalSidecarTranscribeOutput = {
  text: string;
  model: LocalWhisperModel;
  inferenceDevice: string;
  durationMs: number;
  mode: SidecarMode;
};

export type LocalSidecarStreamingSession = {
  writeAudioChunk: (samples: number[] | Float32Array) => void;
  finalize: () => Promise<LocalSidecarTranscribeOutput>;
  cleanup: () => void;
};

const SIDECAR_HOST = "127.0.0.1";
const SIDECAR_BOUND_PORT_PREFIX = "RUST_TRANSCRIPTION_BOUND_PORT=";
const SIDECAR_REQUEST_TIMEOUT_MS = 120_000;
const SIDECAR_REQUEST_RETRIES = 2;
const SIDECAR_REQUEST_RETRY_DELAY_MS = 250;
const MODEL_DOWNLOAD_TIMEOUT_MS = 45 * 60 * 1_000;
const MODEL_DOWNLOAD_POLL_INTERVAL_MS = 500;
const SIDECAR_UPLOAD_CHUNK_SAMPLE_COUNT = 16_000;
const SIDECAR_IDLE_DISPOSE_MS = 60_000;

export class SidecarRequestError extends Error {
  status?: number;
  code?: string;

  constructor(message: string, status?: number, code?: string) {
    super(message);
    this.name = "SidecarRequestError";
    this.status = status;
    this.code = code;
  }
}

export class LocalTranscriptionSidecar extends BaseSidecar {
  readonly mode: SidecarMode;
  private readyModels = new Map<string, Promise<void>>();
  private modelsDirPromise: Promise<string> | null = null;

  constructor(mode: SidecarMode) {
    const binaryName =
      mode === "gpu"
        ? "binaries/rust-transcription-gpu"
        : "binaries/rust-transcription-cpu";

    super({
      binaryName,
      host: SIDECAR_HOST,
      startupTimeoutMs: 15_000,
      healthTimeoutMs: 2_000,
      healthPollIntervalMs: 150,
      logPrefix: `local-sidecar:${mode}`,
      idleDisposeMs: SIDECAR_IDLE_DISPOSE_MS,
    });

    this.mode = mode;
  }

  // --- BaseSidecar abstract implementations ---

  protected async buildSpawnEnv(): Promise<Record<string, string>> {
    const modelsDir = await this.resolveModelsDir();
    return {
      RUST_TRANSCRIPTION_HOST: SIDECAR_HOST,
      RUST_TRANSCRIPTION_PORT: "0",
      RUST_TRANSCRIPTION_MODELS_DIR: modelsDir,
    };
  }

  protected parsePortFromLine(line: string): number | null {
    if (!line.startsWith(SIDECAR_BOUND_PORT_PREFIX)) {
      return null;
    }

    const portValue = line.slice(SIDECAR_BOUND_PORT_PREFIX.length).trim();
    const port = Number.parseInt(portValue, 10);
    if (!Number.isInteger(port) || port <= 0 || port > 65_535) {
      return null;
    }

    return port;
  }

  protected handleStdoutLine(line: string, _child: ShellChildProcess): void {
    getLogger().verbose(`[${this.config.logPrefix}] stdout: ${line}`);
  }

  protected onStarted(_runtime: SidecarRuntime): void {}

  protected onStopped(): void {}

  protected onError(_message: string): void {}

  protected async checkHealthResponse(response: Response): Promise<boolean> {
    const payload = (await response.json()) as SidecarHealthResponse;
    return payload.status === "ok" && payload.mode === this.mode;
  }

  // --- Public API ---

  async getModelStatus(
    model: LocalWhisperModel,
    validate = true,
  ): Promise<LocalSidecarModelStatus> {
    return await this.requestJson<SidecarModelStatusResponse>(
      `/v1/models/${model}/status?validate=${validate ? "true" : "false"}`,
    );
  }

  async listModelStatuses(
    models: LocalWhisperModel[] = LOCAL_WHISPER_MODELS,
    validate = true,
  ): Promise<Record<LocalWhisperModel, LocalSidecarModelStatus>> {
    const statuses = await Promise.all(
      models.map(async (model) => {
        const status = await this.getModelStatus(model, validate);
        return [model, status] as const;
      }),
    );

    const map = {} as Record<LocalWhisperModel, LocalSidecarModelStatus>;
    for (const [model, status] of statuses) {
      map[model] = status;
    }

    return map;
  }

  async listDevices(): Promise<LocalSidecarDevice[]> {
    const response = await this.requestJson<SidecarDevicesResponse>(
      "/v1/devices",
      undefined,
      { retries: 1 },
    );

    return response.devices.map((device) => ({
      ...device,
      mode: this.mode,
    }));
  }

  async downloadModel(
    model: LocalWhisperModel,
    onProgress?: (snapshot: LocalSidecarDownloadSnapshot) => void,
  ): Promise<LocalSidecarModelStatus> {
    await this.downloadModelInternal(model, onProgress);

    const finalStatus = await this.getModelStatus(model, true);
    if (!finalStatus.downloaded || !finalStatus.valid) {
      throw new Error(
        finalStatus.validationError ||
          `Model '${model}' failed validation (${this.mode.toUpperCase()})`,
      );
    }

    this.markModelReady(model);
    return finalStatus;
  }

  async deleteModel(
    model: LocalWhisperModel,
  ): Promise<LocalSidecarModelStatus> {
    const status = await this.requestJson<SidecarModelStatusResponse>(
      `/v1/models/${model}`,
      { method: "DELETE" },
    );

    this.invalidateModelReadiness(model);
    return status;
  }

  async transcribe(
    input: LocalSidecarTranscribeInput,
  ): Promise<LocalSidecarTranscribeOutput> {
    try {
      return await this.transcribeInternal(input);
    } catch (error) {
      if (!this.isModelMissingError(error)) {
        throw error;
      }

      this.invalidateModelReadiness(input.model);
      await this.downloadModelInternal(input.model);
      return await this.transcribeInternal(input);
    }
  }

  async createStreamingSession(
    input: LocalSidecarStreamingSessionInput,
  ): Promise<LocalSidecarStreamingSession> {
    await this.ensureModelReady(input.model);

    const created =
      await this.requestJson<SidecarCreateTranscriptionSessionResponse>(
        "/v1/transcriptions/sessions",
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(this.toSessionConfigPayload(input)),
        },
      );
    this.markModelReady(input.model);

    const sessionPath = `/v1/transcriptions/sessions/${created.sessionId}`;
    getLogger().info(
      `[${this.config.logPrefix}] created streaming session ${created.sessionId}`,
    );
    let queue = Promise.resolve();
    let queuedError: unknown = null;
    let released = false;
    let finalizePromise: Promise<LocalSidecarTranscribeOutput> | null = null;

    const releaseSession = async (): Promise<void> => {
      if (released) {
        return;
      }

      released = true;
      await this.requestJson<SidecarDeleteTranscriptionSessionResponse>(
        sessionPath,
        { method: "DELETE" },
        { retries: 1 },
      );
    };

    const queueChunkUpload = (samples: Float32Array): void => {
      if (released || queuedError || samples.length === 0) {
        return;
      }

      const body = new ArrayBuffer(samples.byteLength);
      new Uint8Array(body).set(
        new Uint8Array(samples.buffer, samples.byteOffset, samples.byteLength),
      );

      queue = queue
        .then(async () => {
          if (released || queuedError) {
            return;
          }

          await this.requestJson<SidecarAppendTranscriptionChunkResponse>(
            `${sessionPath}/chunks`,
            {
              method: "POST",
              headers: { "Content-Type": "application/octet-stream" },
              body,
            },
            { retries: 1 },
          );
        })
        .catch((error) => {
          queuedError = error;
          getLogger().warning(
            `[${this.config.logPrefix}] failed to stream audio chunk (${toErrorMessage(error)})`,
          );
        });
    };

    return {
      writeAudioChunk: (samples) => {
        if (released || finalizePromise) {
          return;
        }
        queueChunkUpload(this.toFloat32Array(samples));
      },
      finalize: async () => {
        if (finalizePromise) {
          return await finalizePromise;
        }

        finalizePromise = (async () => {
          await queue;
          if (queuedError) {
            getLogger().warning(
              `[${this.config.logPrefix}] finalize aborting due to queued chunk error: ${toErrorMessage(queuedError)}`,
            );
            throw queuedError;
          }

          getLogger().info(
            `[${this.config.logPrefix}] sending finalize request for session ${created.sessionId}`,
          );
          const result = await this.requestJson<SidecarTranscriptionResponse>(
            `${sessionPath}/finalize`,
            { method: "POST" },
          );
          getLogger().info(
            `[${this.config.logPrefix}] finalize response received (${result.text.length} chars)`,
          );
          this.markModelReady(input.model);

          return {
            text: result.text,
            model: result.model,
            inferenceDevice: result.inferenceDevice,
            durationMs: result.durationMs,
            mode: this.mode,
          };
        })();

        try {
          return await finalizePromise;
        } finally {
          await releaseSession().catch((error) => {
            getLogger().verbose(
              `[${this.config.logPrefix}] failed to release transcription session (${toErrorMessage(error)})`,
            );
          });
        }
      },
      cleanup: () => {
        void releaseSession().catch((error) => {
          getLogger().verbose(
            `[${this.config.logPrefix}] failed to clean up transcription session (${toErrorMessage(error)})`,
          );
        });
      },
    };
  }

  invalidateModelReadiness(model: LocalWhisperModel): void {
    this.readyModels.delete(model);
  }

  /**
   * Pre-warm the sidecar for a given model so that the first dictation has
   * zero sidecar-spawn latency. Only runs if the model is already downloaded;
   * never triggers a download.
   */
  async warmupModel(model: LocalWhisperModel): Promise<void> {
    const status = await this.getModelStatus(model, false);
    if (!status.downloaded) {
      return;
    }
    this.readyModels.set(model, Promise.resolve());
  }

  // --- Private helpers ---

  private async transcribeInternal(
    input: LocalSidecarTranscribeInput,
  ): Promise<LocalSidecarTranscribeOutput> {
    const session = await this.createStreamingSession(input);
    const floatSamples = this.toFloat32Array(input.samples);

    try {
      for (
        let cursor = 0;
        cursor < floatSamples.length;
        cursor += SIDECAR_UPLOAD_CHUNK_SAMPLE_COUNT
      ) {
        const end = Math.min(
          cursor + SIDECAR_UPLOAD_CHUNK_SAMPLE_COUNT,
          floatSamples.length,
        );
        session.writeAudioChunk(floatSamples.subarray(cursor, end));
      }

      return await session.finalize();
    } catch (error) {
      session.cleanup();
      throw error;
    }
  }

  private toSessionConfigPayload(input: LocalSidecarStreamingSessionInput): {
    model: LocalWhisperModel;
    sampleRate: number;
    language?: string;
    initialPrompt?: string;
    deviceId?: string;
  } {
    const normalizedDeviceId = input.deviceId?.trim().toLowerCase();
    const deviceId =
      this.mode === "gpu"
        ? normalizedDeviceId?.startsWith("gpu:")
          ? normalizedDeviceId
          : undefined
        : normalizedDeviceId?.startsWith("cpu:")
          ? normalizedDeviceId
          : undefined;

    return {
      model: input.model,
      sampleRate: input.sampleRate,
      language: input.language === "auto" ? undefined : input.language,
      initialPrompt: input.initialPrompt,
      deviceId,
    };
  }

  private toFloat32Array(samples: number[] | Float32Array): Float32Array {
    if (samples instanceof Float32Array) {
      return samples;
    }

    return Float32Array.from(samples);
  }

  private async ensureModelReady(model: LocalWhisperModel): Promise<void> {
    const existing = this.readyModels.get(model);
    if (existing) {
      return await existing;
    }

    const pending = this.ensureModelReadyInternal(model)
      .then(() => undefined)
      .catch((error) => {
        this.readyModels.delete(model);
        throw error;
      });

    this.readyModels.set(model, pending);
    await pending;
  }

  private async ensureModelReadyInternal(
    model: LocalWhisperModel,
  ): Promise<void> {
    const currentStatus = await this.getModelStatus(model, true);

    if (!currentStatus.downloaded || !currentStatus.valid) {
      await this.downloadModelInternal(model);
    }

    const finalStatus = await this.getModelStatus(model, true);

    if (!finalStatus.downloaded || !finalStatus.valid) {
      throw new Error(
        finalStatus.validationError ||
          `Model '${model}' failed validation (${this.mode.toUpperCase()})`,
      );
    }

    this.markModelReady(model);
  }

  private markModelReady(model: LocalWhisperModel): void {
    this.readyModels.set(model, Promise.resolve());
  }

  private async downloadModelInternal(
    model: LocalWhisperModel,
    onProgress?: (snapshot: LocalSidecarDownloadSnapshot) => void,
  ): Promise<void> {
    const job = await this.requestJson<SidecarDownloadSnapshot>(
      `/v1/models/${model}/download`,
      { method: "POST" },
    );

    onProgress?.(job);

    if (job.status === "completed") {
      return;
    }

    if (job.status === "failed") {
      throw new Error(
        job.error ||
          `Model download failed for '${model}' (${this.mode.toUpperCase()})`,
      );
    }

    const deadline = Date.now() + MODEL_DOWNLOAD_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const progress = await this.requestJson<SidecarDownloadSnapshot>(
        `/v1/models/${model}/download/${job.jobId}`,
        undefined,
        { retries: 1 },
      );

      onProgress?.(progress);

      if (progress.status === "completed") {
        return;
      }

      if (progress.status === "failed") {
        throw new Error(
          progress.error ||
            `Model download failed for '${model}' (${this.mode.toUpperCase()})`,
        );
      }

      await sleep(MODEL_DOWNLOAD_POLL_INTERVAL_MS);
    }

    throw new Error(
      `Model download timed out for '${model}' (${this.mode.toUpperCase()})`,
    );
  }

  private isModelMissingError(error: unknown): boolean {
    if (!(error instanceof SidecarRequestError)) {
      return false;
    }

    if (error.status !== 404) {
      return false;
    }

    return !error.code || error.code === "model_not_downloaded";
  }

  private async requestJson<T>(
    path: string,
    init?: RequestInit,
    options?: {
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<T> {
    const retries = options?.retries ?? SIDECAR_REQUEST_RETRIES;
    const timeoutMs = options?.timeoutMs ?? SIDECAR_REQUEST_TIMEOUT_MS;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      const runtime = await this.ensureStarted();
      try {
        const result = await this.requestJsonByUrl<T>(runtime.baseUrl, path, {
          init,
          timeoutMs,
          retries: 1,
        });
        this.markActivity();
        return result;
      } catch (error) {
        lastError = error;
        const isTransport = this.isTransportError(error);
        const isRetriable = this.isRetriableError(error);

        getLogger().warning(
          `[${this.config.logPrefix}] request failed for ${path} (attempt ${attempt}/${retries}, transport=${isTransport}, retriable=${isRetriable}): ${String(error)}`,
        );

        if (isTransport) {
          getLogger().warning(
            `[${this.config.logPrefix}] disposing runtime due to transport error`,
          );
          await this.resetRuntime();
        }

        if (attempt < retries && isRetriable) {
          await sleep(SIDECAR_REQUEST_RETRY_DELAY_MS * attempt);
          continue;
        }

        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Request failed for ${this.mode} sidecar at ${path}`);
  }

  private async requestJsonByUrl<T>(
    baseUrl: string,
    path: string,
    options?: {
      init?: RequestInit;
      timeoutMs?: number;
      retries?: number;
    },
  ): Promise<T> {
    const retries = options?.retries ?? SIDECAR_REQUEST_RETRIES;
    const timeoutMs = options?.timeoutMs ?? SIDECAR_REQUEST_TIMEOUT_MS;
    const init = options?.init;
    let lastError: unknown = null;

    for (let attempt = 1; attempt <= retries; attempt += 1) {
      try {
        const url = `${baseUrl}${path}`;
        const response = await fetchWithTimeout(url, init, timeoutMs);

        if (!response.ok) {
          throw await this.buildHttpError(response);
        }

        return (await response.json()) as T;
      } catch (error) {
        lastError = error;
        if (attempt < retries && this.isRetriableError(error)) {
          await sleep(SIDECAR_REQUEST_RETRY_DELAY_MS * attempt);
          continue;
        }
        throw error;
      }
    }

    throw lastError instanceof Error
      ? lastError
      : new Error(`Request failed for ${path}`);
  }

  private async buildHttpError(
    response: Response,
  ): Promise<SidecarRequestError> {
    const status = response.status;
    const fallbackMessage = `Sidecar request failed (${status})`;

    try {
      const payload = (await response.json()) as {
        error?: { code?: string; message?: string };
      };

      const code = payload.error?.code;
      const message = payload.error?.message || fallbackMessage;
      return new SidecarRequestError(message, status, code);
    } catch {
      const text = await response.text().catch(() => "");
      return new SidecarRequestError(
        text.trim() || fallbackMessage,
        status,
        undefined,
      );
    }
  }

  private isRetriableError(error: unknown): boolean {
    if (!(error instanceof SidecarRequestError)) {
      return false;
    }

    if (error.status === undefined) {
      return true;
    }

    return error.status >= 500;
  }

  private isTransportError(error: unknown): boolean {
    return error instanceof SidecarRequestError && error.status === undefined;
  }

  private async resolveModelsDir(): Promise<string> {
    if (!this.modelsDirPromise) {
      this.modelsDirPromise = appDataDir().then(
        async (baseDir) => await join(baseDir, "transcription-models"),
      );
    }
    return await this.modelsDirPromise;
  }
}
