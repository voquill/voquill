import { HandlerOutput } from "@voquill/functions";
import {
  ApiKey,
  AppTarget,
  ChatMessage,
  Conversation,
  EnterpriseConfig,
  EnterpriseLicense,
  FullConfig,
  Hotkey,
  Member,
  Nullable,
  OidcProvider,
  PairedRemoteDevice,
  RemoteReceiverStatus,
  Tenant,
  TenantRole,
  Term,
  Tone,
  ToolInfo,
  ToolPermission,
  Transcription,
  User,
  UserPreferences,
} from "@voquill/types";
import { AuthUser } from "../types/auth.types";
import { Vector2 } from "../types/math.types";
import { OverlayPhase } from "../types/overlay.types";
import {
  PermissionKind,
  PermissionMap,
  PermissionRequestLifecycle,
} from "../types/permission.types";

import { AgentRunState } from "./agent.state";
import { ChatState, INITIAL_CHAT_STATE } from "./chat.state";
import { DictionaryState, INITIAL_DICTIONARY_STATE } from "./dictionary.state";
import { INITIAL_LOCAL_STATE, LocalState } from "./local.state";
import { INITIAL_LOGIN_STATE, LoginState } from "./login.state";
import {
  INITIAL_ONBOARDING_STATE,
  type OnboardingState,
} from "./onboarding.state";
import { INITIAL_PAYMENT_STATE, PaymentState } from "./payment.state";
import { INITIAL_PRICING_STATE, PricingState } from "./pricing.state";
import { INITIAL_SETTINGS_STATE, SettingsState } from "./settings.state";
import {
  INITIAL_TONE_EDITOR_STATE,
  ToneEditorState,
} from "./tone-editor.state";
import { INITIAL_TONES_STATE, TonesState } from "./tones.state";
import {
  INITIAL_TRANSCRIPTIONS_STATE,
  TranscriptionsState,
} from "./transcriptions.state";
import { INITIAL_UPDATER_STATE, UpdaterState } from "./updater.state";

export type SnackbarMode = "info" | "success" | "error";
export type HotkeyStrategy = "listener" | "bridge";
export type PasteKeybindSupport = "disabled" | "per-app" | "global";

export type StreamingToolCall = {
  toolCallId: string;
  toolName: string;
  done: boolean;
};

export type StreamingMessageState = {
  toolCalls: StreamingToolCall[];
  reasoning: string;
  isStreaming: boolean;
};

export type RecordingMode = "dictate" | "agent";

type PermissionRequestMap = Record<PermissionKind, PermissionRequestLifecycle>;

export type AssistantInputMode = "voice" | "type";

export type PriceValue = HandlerOutput<"stripe/getPrices">["prices"];

export type MyTenantMembership = {
  tenant: Tenant;
  role: TenantRole;
  hasSeat: boolean;
};

export type AppState = {
  initialized: boolean;
  auth: Nullable<AuthUser>;
  keysHeld: string[];
  isRecordingHotkey: boolean;
  activeRecordingMode: Nullable<RecordingMode>;
  dictationLanguageOverride: Nullable<string>;
  overlayPhase: OverlayPhase;
  audioLevels: number[];
  permissions: PermissionMap;
  permissionRequests: PermissionRequestMap;
  confettiCounter: number;
  userPrefs: Nullable<UserPreferences>;
  localStorageCache: Record<string, unknown>;

  memberById: Record<string, Member>;
  userById: Record<string, User>;
  /** First tenant the signed-in user belongs to, with their role and seat
   * status on it. Null if the user has no tenants. */
  myTenant: Nullable<MyTenantMembership>;
  termById: Record<string, Term>;
  appTargetById: Record<string, AppTarget>;
  pairedRemoteDeviceById: Record<string, PairedRemoteDevice>;
  remoteReceiverStatus: Nullable<RemoteReceiverStatus>;
  transcriptionById: Record<string, Transcription>;
  hotkeyById: Record<string, Hotkey>;
  apiKeyById: Record<string, ApiKey>;
  toneById: Record<string, Tone>;
  conversationById: Record<string, Conversation>;
  chatMessageById: Record<string, ChatMessage>;
  chatMessageIdsByConversationId: Record<string, string[]>;
  toolInfoById: Record<string, ToolInfo>;
  toolPermissionById: Record<string, ToolPermission>;
  agentStateByConversationId: Record<string, AgentRunState>;
  streamingMessageById: Record<string, StreamingMessageState>;
  config: Nullable<FullConfig>;
  priceValueByKey: Record<string, PriceValue>;
  enterpriseConfig: Nullable<EnterpriseConfig>;
  enterpriseLicense: Nullable<EnterpriseLicense>;
  isEnterprise: boolean;
  oidcProviders: OidcProvider[];

  local: LocalState;
  onboarding: OnboardingState;
  transcriptions: TranscriptionsState;
  dictionary: DictionaryState;
  tones: TonesState;
  toneEditor: ToneEditorState;
  settings: SettingsState;
  updater: UpdaterState;
  payment: PaymentState;
  pricing: PricingState;
  login: LoginState;
  pillConversationId: Nullable<string>;
  assistantInputMode: AssistantInputMode;
  chat: ChatState;

  snackbarMessage?: string;
  snackbarCounter: number;
  snackbarMode: SnackbarMode;
  snackbarDuration: number;
  snackbarTransitionDuration?: number;

  overlayCursor: Nullable<Vector2>;
  hotkeyTriggers: Record<string, number>;
  hotkeyStrategy: Nullable<HotkeyStrategy>;
  supportsAppDetection: boolean;
  supportsPasteKeybinds: PasteKeybindSupport;
};

export const INITIAL_APP_STATE: AppState = {
  userPrefs: null,
  isRecordingHotkey: false,
  activeRecordingMode: null,
  dictationLanguageOverride: null,
  enterpriseConfig: null,
  enterpriseLicense: null,
  isEnterprise: false,
  localStorageCache: {},
  oidcProviders: [],
  memberById: {},
  userById: {},
  myTenant: null,
  termById: {},
  appTargetById: {},
  pairedRemoteDeviceById: {},
  remoteReceiverStatus: null,
  transcriptionById: {},
  priceValueByKey: {},
  apiKeyById: {},
  toneById: {},
  conversationById: {},
  chatMessageById: {},
  chatMessageIdsByConversationId: {},
  toolInfoById: {},
  toolPermissionById: {},
  agentStateByConversationId: {},
  streamingMessageById: {},
  overlayPhase: "idle",
  audioLevels: [],
  permissions: {
    microphone: null,
    accessibility: null,
    "screen-recording": {
      kind: "screen-recording",
      state: "not-determined",
      promptShown: false,
    },
  },
  permissionRequests: {
    microphone: {
      requestInFlight: false,
      awaitingExternalApproval: false,
    },
    accessibility: {
      requestInFlight: false,
      awaitingExternalApproval: false,
    },
    "screen-recording": {
      requestInFlight: false,
      awaitingExternalApproval: false,
    },
  },
  hotkeyById: {},
  auth: null,
  confettiCounter: 0,
  config: null,
  keysHeld: [],
  initialized: false,
  snackbarCounter: 0,
  snackbarMode: "info",
  snackbarDuration: 3000,
  snackbarTransitionDuration: undefined,
  overlayCursor: null,
  hotkeyTriggers: {},
  hotkeyStrategy: null,
  supportsAppDetection: true,
  supportsPasteKeybinds: "disabled",
  pillConversationId: null,
  assistantInputMode: "voice",
  local: INITIAL_LOCAL_STATE,
  chat: INITIAL_CHAT_STATE,
  onboarding: INITIAL_ONBOARDING_STATE,
  transcriptions: INITIAL_TRANSCRIPTIONS_STATE,
  dictionary: INITIAL_DICTIONARY_STATE,
  tones: INITIAL_TONES_STATE,
  toneEditor: INITIAL_TONE_EDITOR_STATE,
  settings: INITIAL_SETTINGS_STATE,
  updater: INITIAL_UPDATER_STATE,
  payment: INITIAL_PAYMENT_STATE,
  pricing: INITIAL_PRICING_STATE,
  login: INITIAL_LOGIN_STATE,
};
