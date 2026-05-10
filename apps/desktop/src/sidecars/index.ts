import {
  supportsGpuTranscriptionDevice,
  type LocalWhisperModel,
  LOCAL_WHISPER_MODELS,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import {
  LocalTranscriptionSidecar,
  SidecarRequestError,
  type LocalSidecarDevice,
  type LocalSidecarDownloadSnapshot,
  type LocalSidecarModelStatus,
  type LocalSidecarStreamingSession,
  type LocalSidecarStreamingSessionInput,
  type LocalSidecarTranscribeInput,
  type LocalSidecarTranscribeOutput,
} from "./local-transcription.sidecar";
import { toErrorMessage } from "./sidecar.utils";

export type {
  LocalSidecarDevice,
  LocalSidecarDownloadSnapshot,
  LocalSidecarModelStatus,
  LocalSidecarStreamingSession,
  LocalSidecarStreamingSessionInput,
  LocalSidecarTranscribeInput,
  LocalSidecarTranscribeOutput,
} from "./local-transcription.sidecar";

class LocalTranscriptionSidecarFacade {
  private cpuSidecar = new LocalTranscriptionSidecar("cpu");
  private gpuSidecar = new LocalTranscriptionSidecar("gpu");
  private gpuUnavailable = false;

  async listAvailableDevices(): Promise<LocalSidecarDevice[]> {
    await this.cpuSidecar.ensureStarted();
    const cpuDevices = await this.cpuSidecar.listDevices();
    const devices = [...cpuDevices];

    if (supportsGpuTranscriptionDevice() && !this.gpuUnavailable) {
      try {
        await this.gpuSidecar.ensureStarted();
        const gpuDevices = await this.gpuSidecar.listDevices();
        devices.push(...gpuDevices);
      } catch (error) {
        this.markGpuUnavailable(error);
      }
    }

    return devices;
  }

  async listModelStatuses({
    preferGpu,
    validate = true,
    models = LOCAL_WHISPER_MODELS,
  }: {
    preferGpu: boolean;
    validate?: boolean;
    models?: LocalWhisperModel[];
  }): Promise<Record<LocalWhisperModel, LocalSidecarModelStatus>> {
    const sidecar = await this.resolveRuntime(preferGpu);
    return await sidecar.listModelStatuses(models, validate);
  }

  async getModelStatus({
    model,
    preferGpu,
    validate = true,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
    validate?: boolean;
  }): Promise<LocalSidecarModelStatus> {
    const sidecar = await this.resolveRuntime(preferGpu);
    return await sidecar.getModelStatus(model, validate);
  }

  async downloadModel({
    model,
    preferGpu,
    onProgress,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
    onProgress?: (snapshot: LocalSidecarDownloadSnapshot) => void;
  }): Promise<LocalSidecarModelStatus> {
    const sidecar = await this.resolveRuntime(preferGpu);
    return await sidecar.downloadModel(model, onProgress);
  }

  async deleteModel({
    model,
    preferGpu,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
  }): Promise<LocalSidecarModelStatus> {
    const sidecar = await this.resolveRuntime(preferGpu);
    const result = await sidecar.deleteModel(model);
    this.cpuSidecar.invalidateModelReadiness(model);
    this.gpuSidecar.invalidateModelReadiness(model);
    return result;
  }

  async transcribe(
    input: LocalSidecarTranscribeInput,
  ): Promise<LocalSidecarTranscribeOutput> {
    const sidecar = await this.resolveRuntime(input.preferGpu);

    try {
      return await sidecar.transcribe(input);
    } catch (error) {
      if (
        input.preferGpu &&
        sidecar === this.gpuSidecar &&
        this.shouldFallbackToCpu(error)
      ) {
        this.markGpuUnavailable(error);
        return await this.cpuSidecar.transcribe({
          ...input,
          deviceId: undefined,
        });
      }

      throw error;
    }
  }

  async createStreamingSession(
    input: LocalSidecarStreamingSessionInput,
  ): Promise<LocalSidecarStreamingSession> {
    const sidecar = await this.resolveRuntime(input.preferGpu);

    try {
      return await sidecar.createStreamingSession(input);
    } catch (error) {
      if (
        input.preferGpu &&
        sidecar === this.gpuSidecar &&
        this.shouldFallbackToCpu(error)
      ) {
        this.markGpuUnavailable(error);
        return await this.cpuSidecar.createStreamingSession({
          ...input,
          deviceId: undefined,
        });
      }

      throw error;
    }
  }

  async warmupModel({
    model,
    preferGpu,
  }: {
    model: LocalWhisperModel;
    preferGpu: boolean;
  }): Promise<void> {
    const sidecar = await this.resolveRuntime(preferGpu);
    await sidecar.warmupModel(model);
  }

  private async resolveRuntime(
    preferGpu: boolean,
  ): Promise<LocalTranscriptionSidecar> {
    if (preferGpu && !this.gpuUnavailable) {
      try {
        await this.gpuSidecar.ensureStarted();
        return this.gpuSidecar;
      } catch (error) {
        this.markGpuUnavailable(error);
      }
    }

    await this.cpuSidecar.ensureStarted();
    return this.cpuSidecar;
  }

  private shouldFallbackToCpu(error: unknown): boolean {
    if (error instanceof SidecarRequestError) {
      return error.status === undefined;
    }

    const message = toErrorMessage(error).toLowerCase();
    return message.includes("sidecar") || message.includes("request failed");
  }

  private markGpuUnavailable(error: unknown): void {
    this.gpuUnavailable = true;
    getLogger().warning(
      `[local-sidecar:gpu] unavailable, falling back to CPU (${toErrorMessage(error)})`,
    );
  }
}

let localTranscriptionFacade: LocalTranscriptionSidecarFacade | null = null;

export const getLocalTranscriptionSidecarManager =
  (): LocalTranscriptionSidecarFacade => {
    localTranscriptionFacade ??= new LocalTranscriptionSidecarFacade();
    return localTranscriptionFacade;
  };
