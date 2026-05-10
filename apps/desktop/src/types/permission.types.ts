import { Nullable } from "@voquill/types";

export type PermissionKind =
  | "microphone"
  | "accessibility"
  | "screen-recording";

export type PermissionState =
  | "authorized"
  | "denied"
  | "restricted"
  | "not-determined";

export type PermissionStatus = {
  kind: PermissionKind;
  state: PermissionState;
  promptShown: boolean;
};

export type PermissionMap = Record<PermissionKind, Nullable<PermissionStatus>>;

export type PermissionRequestLifecycle = {
  requestInFlight: boolean;
  awaitingExternalApproval: boolean;
};

export type PermissionGateStateInput = PermissionRequestLifecycle & {
  kind: PermissionKind;
  status: Nullable<PermissionStatus>;
};

export type PermissionGateState = {
  canRequest: boolean;
  isAwaitingExternalApproval: boolean;
  shouldOpenSettings: boolean;
};
