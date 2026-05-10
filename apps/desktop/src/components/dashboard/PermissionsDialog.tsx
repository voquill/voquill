import {
  CheckCircleOutline,
  HighlightOff,
  OpenInNew,
  PendingOutlined,
  RestartAlt,
} from "@mui/icons-material";
import {
  Alert,
  Button,
  Box,
  Chip,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  Stack,
  Typography,
} from "@mui/material";
import { relaunch } from "@tauri-apps/plugin-process";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { FormattedMessage, useIntl } from "react-intl";
import { produceAppState, useAppStore } from "../../store";
import type { PermissionKind } from "../../types/permission.types";
import {
  canRequestPermission,
  derivePermissionsDialogViewState,
  derivePermissionGateState,
  resolvePermissionRequestLifecycle,
} from "../../utils/permission-flow.utils";
import {
  ENHANCEMENT_PERMISSIONS,
  REQUIRED_PERMISSIONS,
  describePermissionState,
  getPermissionInstructions,
  getPermissionLabel,
  isPermissionAuthorized,
  isPermissionRequestActionable,
  requestAccessibilityPermission,
  requestMicrophonePermission,
  requestScreenRecordingPermission,
} from "../../utils/permission.utils";
import { useLocation } from "react-router-dom";
import { setGotStartedAtNow } from "../../actions/user.actions";

const ICON_SIZE = 28;

const getPurposeDescription = (
  kind: PermissionKind,
  intl: ReturnType<typeof useIntl>,
): string => {
  const descriptions: Record<PermissionKind, string> = {
    microphone: intl.formatMessage({
      defaultMessage:
        "Allows Voquill to capture audio from your microphone for transcription.",
    }),
    accessibility: intl.formatMessage({
      defaultMessage:
        "Lets you trigger dictation hotkeys while using other applications.",
    }),
    "screen-recording": intl.formatMessage({
      defaultMessage:
        "Optional enhancement for OCR and screen context support. Enables Voquill to read on-screen text to improve dictation accuracy.",
    }),
  };
  return descriptions[kind];
};

const PermissionRow = ({ kind }: { kind: PermissionKind }) => {
  const intl = useIntl();
  const status = useAppStore((state) => state.permissions[kind]);
  const requestLifecycle = useAppStore(
    (state) => state.permissionRequests[kind],
  );
  const gateState = useMemo(
    () =>
      derivePermissionGateState({
        kind,
        status,
        requestInFlight: requestLifecycle.requestInFlight,
        awaitingExternalApproval: requestLifecycle.awaitingExternalApproval,
      }),
    [kind, requestLifecycle, status],
  );
  const isRequestActionable = isPermissionRequestActionable(kind);
  const canRequest = canRequestPermission({ kind, gateState });

  const { icon, color, chipColor, chipLabel } = useMemo(() => {
    if (!isRequestActionable) {
      return {
        icon: <PendingOutlined sx={{ fontSize: ICON_SIZE }} />,
        color: "text.secondary" as const,
        chipColor: "default" as const,
        chipLabel: intl.formatMessage({ defaultMessage: "Coming soon" }),
      };
    }

    if (!status || requestLifecycle.requestInFlight) {
      return {
        icon: <PendingOutlined sx={{ fontSize: ICON_SIZE }} />,
        color: "text.secondary" as const,
        chipColor: "default" as const,
        chipLabel: requestLifecycle.requestInFlight
          ? intl.formatMessage({ defaultMessage: "Requesting" })
          : intl.formatMessage({ defaultMessage: "Checking" }),
      };
    }

    if (gateState.isAwaitingExternalApproval) {
      return {
        icon: <PendingOutlined sx={{ fontSize: ICON_SIZE }} />,
        color: "warning.main" as const,
        chipColor: "warning" as const,
        chipLabel: intl.formatMessage({ defaultMessage: "Awaiting approval" }),
      };
    }

    if (isPermissionAuthorized(status.state)) {
      return {
        icon: (
          <CheckCircleOutline color="success" sx={{ fontSize: ICON_SIZE }} />
        ),
        color: "success.main" as const,
        chipColor: "success" as const,
        chipLabel: intl.formatMessage({ defaultMessage: "Authorized" }),
      };
    }

    return {
      icon: <HighlightOff color="error" sx={{ fontSize: ICON_SIZE }} />,
      color: "error.main" as const,
      chipColor: "error" as const,
      chipLabel: describePermissionState(status.state),
    };
  }, [
    gateState.isAwaitingExternalApproval,
    isRequestActionable,
    intl,
    requestLifecycle.requestInFlight,
    status,
  ]);

  const instructions = gateState.isAwaitingExternalApproval
    ? intl.formatMessage({
        defaultMessage:
          "Finish enabling this permission in System Settings, then return to Voquill.",
      })
    : getPermissionInstructions(kind);
  const title = getPermissionLabel(kind);
  const buttonLabel = !isRequestActionable
    ? intl.formatMessage({ defaultMessage: "Coming soon" })
    : requestLifecycle.requestInFlight
      ? intl.formatMessage({ defaultMessage: "Requesting" })
      : gateState.isAwaitingExternalApproval
        ? intl.formatMessage({ defaultMessage: "Awaiting approval" })
        : gateState.shouldOpenSettings
          ? intl.formatMessage({ defaultMessage: "Open settings" })
          : intl.formatMessage({ defaultMessage: "Enable" });

  const handleRequest = useCallback(async () => {
    const latestState = useAppStore.getState();
    const latestGateState = derivePermissionGateState({
      kind,
      status: latestState.permissions[kind],
      requestInFlight: latestState.permissionRequests[kind].requestInFlight,
      awaitingExternalApproval:
        latestState.permissionRequests[kind].awaitingExternalApproval,
    });

    if (!canRequestPermission({ kind, gateState: latestGateState })) {
      return;
    }

    produceAppState((draft) => {
      draft.permissionRequests[kind].requestInFlight = true;
    });

    try {
      const requestFn =
        kind === "microphone"
          ? requestMicrophonePermission
          : kind === "accessibility"
            ? requestAccessibilityPermission
            : requestScreenRecordingPermission;
      const result = await requestFn();
      produceAppState((draft) => {
        draft.permissions[kind] = result;
        draft.permissionRequests[kind] = resolvePermissionRequestLifecycle({
          kind,
          status: result,
          requestInFlight: draft.permissionRequests[kind].requestInFlight,
          awaitingExternalApproval:
            draft.permissionRequests[kind].awaitingExternalApproval,
        });
      });
    } catch (error) {
      console.error(`Failed to request ${kind} permission`, error);
      produceAppState((draft) => {
        draft.permissionRequests[kind].requestInFlight = false;
      });
    }
  }, [kind]);

  return (
    <Stack
      direction="row"
      spacing={2}
      alignItems="flex-start"
      sx={{ paddingY: 1.5 }}
    >
      <Box sx={{ lineHeight: 0, color }}>{icon}</Box>
      <Stack spacing={0.5} sx={{ flex: 1 }}>
        <Stack direction="row" spacing={1} alignItems="center">
          <Typography variant="h6">{title}</Typography>
          <Chip size="small" color={chipColor} label={chipLabel} />
        </Stack>
        <Typography variant="body2" sx={{ fontWeight: 500 }}>
          {instructions}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {getPurposeDescription(kind, intl)}
        </Typography>
      </Stack>
      <Button
        variant="outlined"
        size="small"
        onClick={() => void handleRequest()}
        disabled={!canRequest}
        endIcon={
          !isRequestActionable ||
          requestLifecycle.requestInFlight ||
          gateState.isAwaitingExternalApproval ? undefined : (
            <OpenInNew />
          )
        }
      >
        {buttonLabel}
      </Button>
    </Stack>
  );
};

export const PermissionsDialog = () => {
  const intl = useIntl();
  const permissions = useAppStore((state) => state.permissions);
  const [isManuallyOpened, setIsManuallyOpened] = useState(false);
  const [permissionWasGranted, setPermissionWasGranted] = useState(false);
  const previousPermissionsRef = useRef(permissions);
  const location = useLocation();
  const isWelcomePage = location.pathname === "/welcome";

  // Track when a permission transitions from not authorized to authorized
  useEffect(() => {
    const prev = previousPermissionsRef.current;
    for (const kind of REQUIRED_PERMISSIONS) {
      const prevStatus = prev[kind];
      const currentStatus = permissions[kind];
      if (
        prevStatus &&
        currentStatus &&
        !isPermissionAuthorized(prevStatus.state) &&
        isPermissionAuthorized(currentStatus.state)
      ) {
        setPermissionWasGranted(true);
        break;
      }
    }
    previousPermissionsRef.current = permissions;
  }, [permissions]);

  const viewState = useMemo(
    () =>
      derivePermissionsDialogViewState({
        permissions,
        permissionWasGranted,
        isWelcomePage,
        isManuallyOpened,
      }),
    [permissions, permissionWasGranted, isWelcomePage, isManuallyOpened],
  );
  const canCloseManually =
    isManuallyOpened &&
    !viewState.shouldAutoOpen &&
    !viewState.shouldShowRestartMessage;
  const isOptionalEnhancementsView =
    viewState.shouldShowManualEntry &&
    !viewState.shouldAutoOpen &&
    !viewState.shouldShowRestartMessage;
  const dialogTitle = isOptionalEnhancementsView
    ? intl.formatMessage({ defaultMessage: "Optional permissions" })
    : intl.formatMessage({ defaultMessage: "Permissions needed" });
  const dialogDescription = isOptionalEnhancementsView
    ? intl.formatMessage({
        defaultMessage:
          "Voquill already has its required startup permissions. Screen recording is only an optional enhancement for future OCR and screen context features.",
      })
    : intl.formatMessage({
        defaultMessage:
          "Voquill is an AI dictation tool. It needs microphone and accessibility access in order to function properly.",
      });

  useEffect(() => {
    if (viewState.shouldAutoOpen) {
      setGotStartedAtNow();
    }
  }, [viewState.shouldAutoOpen]);

  const handleRestart = useCallback(async () => {
    try {
      await relaunch();
    } catch (error) {
      console.error("Failed to restart application", error);
    }
  }, []);

  const handleClose = (
    _event: unknown,
    reason: "backdropClick" | "escapeKeyDown",
  ) => {
    if (reason === "backdropClick" || reason === "escapeKeyDown") {
      return;
    }
  };

  return (
    <>
      {viewState.shouldShowManualEntry && !viewState.isOpen && (
        <Box
          sx={{
            position: "fixed",
            right: 24,
            bottom: 24,
            zIndex: (theme) => theme.zIndex.appBar,
          }}
        >
          <Button variant="outlined" onClick={() => setIsManuallyOpened(true)}>
            <FormattedMessage defaultMessage="Optional permissions" />
          </Button>
        </Box>
      )}
      <Dialog
        open={viewState.isOpen}
        onClose={handleClose}
        fullWidth
        maxWidth="sm"
        disableEscapeKeyDown
        slotProps={{
          backdrop: {
            sx: { backdropFilter: "blur(4px)" },
          },
          paper: {
            sx: (theme) => ({
              paddingBottom: 2,
              backgroundColor: theme.vars?.palette.level1,
            }),
          },
        }}
      >
        <DialogTitle>
          {dialogTitle}
        </DialogTitle>
        <DialogContent>
          <Stack spacing={3}>
            <Typography variant="body1">{dialogDescription}</Typography>
            <Stack>
              {REQUIRED_PERMISSIONS.map((kind) => (
                <PermissionRow key={kind} kind={kind} />
              ))}
            </Stack>
            <Stack spacing={1}>
              <Typography variant="overline" color="text.secondary">
                <FormattedMessage defaultMessage="Optional enhancements" />
              </Typography>
              <Stack>
                {ENHANCEMENT_PERMISSIONS.map((kind) => (
                  <PermissionRow key={kind} kind={kind} />
                ))}
              </Stack>
            </Stack>
            {viewState.shouldShowRestartMessage && (
              <Alert
                severity="info"
                action={
                  <Button
                    color="inherit"
                    size="small"
                    onClick={() => void handleRestart()}
                    startIcon={<RestartAlt />}
                  >
                    <FormattedMessage defaultMessage="Restart" />
                  </Button>
                }
              >
                <FormattedMessage defaultMessage="Please restart the application for the new permissions to take effect." />
              </Alert>
            )}
          </Stack>
        </DialogContent>
        {canCloseManually && (
          <DialogActions sx={{ paddingX: 3 }}>
            <Button onClick={() => setIsManuallyOpened(false)}>
              <FormattedMessage defaultMessage="Close" />
            </Button>
          </DialogActions>
        )}
      </Dialog>
    </>
  );
};
