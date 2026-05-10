import type {
  PermissionGateState,
  PermissionGateStateInput,
  PermissionMap,
  PermissionRequestLifecycle,
} from "../types/permission.types";
import {
  REQUIRED_PERMISSIONS,
  isPermissionAuthorized,
  isPermissionDenied,
  isPermissionRequestActionable,
  isPermissionRestricted,
} from "./permission.utils";

export const derivePermissionGateState = ({
  kind,
  status,
  requestInFlight,
  awaitingExternalApproval,
}: PermissionGateStateInput): PermissionGateState => {
  const state = status?.state;
  const isAuthorized = isPermissionAuthorized(state);
  const isWaitingForExternalApproval =
    kind === "accessibility" &&
    awaitingExternalApproval &&
    !requestInFlight &&
    !isAuthorized;

  return {
    canRequest:
      !requestInFlight &&
      !isAuthorized &&
      !isPermissionRestricted(state) &&
      !isWaitingForExternalApproval,
    isAwaitingExternalApproval: isWaitingForExternalApproval,
    shouldOpenSettings:
      isPermissionDenied(state) &&
      !requestInFlight &&
      !isWaitingForExternalApproval,
  };
};

export const resolvePermissionRequestLifecycle = ({
  kind,
  status,
  requestInFlight,
  awaitingExternalApproval,
}: PermissionGateStateInput): PermissionRequestLifecycle => {
  const state = status?.state;
  const isAuthorized = isPermissionAuthorized(state);

  if (isAuthorized) {
    return {
      requestInFlight: false,
      awaitingExternalApproval: false,
    };
  }

  const shouldKeepAwaitingExternalApproval =
    kind === "accessibility" &&
    !isPermissionDenied(state) &&
    !isPermissionRestricted(state) &&
    ((requestInFlight && Boolean(status?.promptShown)) ||
      awaitingExternalApproval);

  return {
    requestInFlight: false,
    awaitingExternalApproval: shouldKeepAwaitingExternalApproval,
  };
};

type CanRequestPermissionInput = {
  kind: PermissionGateStateInput["kind"];
  gateState: PermissionGateState;
};

export const canRequestPermission = ({
  kind,
  gateState,
}: CanRequestPermissionInput): boolean => {
  return isPermissionRequestActionable(kind) && gateState.canRequest;
};

type PermissionsDialogViewStateInput = {
  permissions: PermissionMap;
  permissionWasGranted: boolean;
  isWelcomePage: boolean;
  isManuallyOpened: boolean;
};

type PermissionsDialogViewState = {
  ready: boolean;
  blocked: boolean;
  allAuthorized: boolean;
  shouldAutoOpen: boolean;
  shouldShowRestartMessage: boolean;
  shouldShowManualEntry: boolean;
  isOpen: boolean;
};

export const derivePermissionsDialogViewState = ({
  permissions,
  permissionWasGranted,
  isWelcomePage,
  isManuallyOpened,
}: PermissionsDialogViewStateInput): PermissionsDialogViewState => {
  let ready = true;
  let blocked = false;
  let allAuthorized = true;

  for (const kind of REQUIRED_PERMISSIONS) {
    const status = permissions[kind];
    if (!status) {
      ready = false;
      allAuthorized = false;
      continue;
    }

    if (!isPermissionAuthorized(status.state)) {
      blocked = true;
      allAuthorized = false;
    }
  }

  const shouldAutoOpen = ready && blocked && !isWelcomePage;
  const shouldShowRestartMessage = allAuthorized && permissionWasGranted;
  const shouldShowManualEntry = ready && allAuthorized;

  return {
    ready,
    blocked,
    allAuthorized,
    shouldAutoOpen,
    shouldShowRestartMessage,
    shouldShowManualEntry,
    isOpen: isManuallyOpened || shouldAutoOpen || shouldShowRestartMessage,
  };
};
