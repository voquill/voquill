import {
  ApiKey,
  ApiKeyProvider,
  OpenRouterModel,
  OpenRouterProvider,
} from "@voquill/types";
import type {
  LocalSidecarDevice,
  LocalSidecarDownloadSnapshot,
  LocalSidecarModelStatus,
} from "../sidecars";
import {
  LOCAL_WHISPER_MODELS,
  type LocalWhisperModel,
} from "../utils/local-transcription.utils";
import {
  type AgentMode,
  CPU_DEVICE_VALUE,
  DEFAULT_MODEL_SIZE,
  type PostProcessingMode,
  type TranscriptionMode,
} from "../types/ai.types";
import { ActionStatus } from "../types/state.types";

export type SettingsApiKeyProvider = ApiKeyProvider;

export type SettingsApiKey = ApiKey;

export type LocalTranscriptionModelStatusMap = Record<
  LocalWhisperModel,
  LocalSidecarModelStatus | null
>;

export type LocalTranscriptionModelManagementState = {
  modelStatuses: LocalTranscriptionModelStatusMap;
  modelStatusesLoading: boolean;
  modelStatusesLoaded: boolean;
  modelDownloads: Partial<
    Record<LocalWhisperModel, LocalSidecarDownloadSnapshot>
  >;
  modelDeletes: Partial<Record<LocalWhisperModel, boolean>>;
};

export type SettingsTranscriptionState = {
  mode: TranscriptionMode | null;
  modelSize: string;
  device: string;
  availableDevices: LocalSidecarDevice[];
  availableDevicesLoading: boolean;
  selectedApiKeyId: string | null;
  gpuEnumerationEnabled: boolean;
  localModelManagement: LocalTranscriptionModelManagementState;
};

export type SettingsGenerativeState = {
  mode: PostProcessingMode | null;
  selectedApiKeyId: string | null;
};

export type SettingsAgentModeState = Omit<SettingsGenerativeState, "mode"> & {
  mode: AgentMode | null;
  openclawGatewayUrl: string | null;
  openclawToken: string | null;
};

export type SettingsState = {
  changePasswordDialogOpen: boolean;
  deleteAccountDialog: boolean;
  microphoneDialogOpen: boolean;
  audioDialogOpen: boolean;
  shortcutsDialogOpen: boolean;
  clearLocalDataDialogOpen: boolean;
  profileDialogOpen: boolean;
  aiTranscriptionDialogOpen: boolean;
  aiPostProcessingDialogOpen: boolean;
  agentModeDialogOpen: boolean;
  moreSettingsDialogOpen: boolean;
  multiDeviceDialogOpen: boolean;
  dictationLanguageDialogOpen: boolean;
  appKeybindingsDialogOpen: boolean;
  diagnosticsDialogOpen: boolean;
  mobileAppDialogOpen: boolean;
  googleCalendarDialogOpen: boolean;
  aiTranscription: SettingsTranscriptionState;
  aiPostProcessing: SettingsGenerativeState;
  agentMode: SettingsAgentModeState;
  apiKeys: SettingsApiKey[];
  apiKeysStatus: ActionStatus;
  hotkeyIds: string[];
  hotkeysStatus: ActionStatus;
  autoLaunchEnabled: boolean;
  autoLaunchStatus: ActionStatus;
  openRouterModels: OpenRouterModel[];
  openRouterModelsStatus: ActionStatus;
  openRouterSearchQuery: string;
  openRouterProviders: OpenRouterProvider[];
  openRouterProvidersStatus: ActionStatus;
};

export const createEmptyLocalTranscriptionModelStatusMap =
  (): LocalTranscriptionModelStatusMap =>
    Object.fromEntries(
      LOCAL_WHISPER_MODELS.map((model) => [model, null]),
    ) as LocalTranscriptionModelStatusMap;

export const isLocalTranscriptionModelDownloadInProgress = (
  snapshot: LocalSidecarDownloadSnapshot | undefined,
): boolean => {
  return snapshot?.status === "pending" || snapshot?.status === "running";
};

export const isLocalTranscriptionModelSelectable = (
  transcription: SettingsTranscriptionState,
  model: LocalWhisperModel,
): boolean => {
  const status = transcription.localModelManagement.modelStatuses[model];
  return !!status?.downloaded && !!status?.valid;
};

export const INITIAL_SETTINGS_STATE: SettingsState = {
  changePasswordDialogOpen: false,
  deleteAccountDialog: false,
  microphoneDialogOpen: false,
  audioDialogOpen: false,
  shortcutsDialogOpen: false,
  clearLocalDataDialogOpen: false,
  profileDialogOpen: false,
  aiTranscriptionDialogOpen: false,
  aiPostProcessingDialogOpen: false,
  agentModeDialogOpen: false,
  moreSettingsDialogOpen: false,
  multiDeviceDialogOpen: false,
  dictationLanguageDialogOpen: false,
  appKeybindingsDialogOpen: false,
  diagnosticsDialogOpen: false,
  mobileAppDialogOpen: false,
  googleCalendarDialogOpen: false,
  aiTranscription: {
    mode: null,
    modelSize: DEFAULT_MODEL_SIZE,
    device: CPU_DEVICE_VALUE,
    availableDevices: [],
    availableDevicesLoading: false,
    selectedApiKeyId: null,
    gpuEnumerationEnabled: false,
    localModelManagement: {
      modelStatuses: createEmptyLocalTranscriptionModelStatusMap(),
      modelStatusesLoading: false,
      modelStatusesLoaded: false,
      modelDownloads: {},
      modelDeletes: {},
    },
  },
  aiPostProcessing: {
    mode: null,
    selectedApiKeyId: null,
  },
  agentMode: {
    mode: null,
    selectedApiKeyId: null,
    openclawGatewayUrl: null,
    openclawToken: null,
  },
  apiKeys: [],
  apiKeysStatus: "idle",
  hotkeyIds: [],
  hotkeysStatus: "idle",
  autoLaunchEnabled: false,
  autoLaunchStatus: "idle",
  openRouterModels: [],
  openRouterModelsStatus: "idle",
  openRouterSearchQuery: "",
  openRouterProviders: [],
  openRouterProvidersStatus: "idle",
};
