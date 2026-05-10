import { ArrowForward, Check, OpenInNew } from "@mui/icons-material";
import { Box, Button, Stack, Typography } from "@mui/material";
import { useCallback, useMemo } from "react";
import { FormattedMessage } from "react-intl";
import { goToOnboardingPage } from "../../actions/onboarding.actions";
import enableMicVideo from "../../assets/enable-mic.mp4";
import { produceAppState, useAppStore } from "../../store";
import { trackButtonClick } from "../../utils/analytics.utils";
import {
  derivePermissionGateState,
  resolvePermissionRequestLifecycle,
} from "../../utils/permission-flow.utils";
import {
  isPermissionAuthorized,
  requestMicrophonePermission,
} from "../../utils/permission.utils";
import {
  BackButton,
  DualPaneLayout,
  OnboardingFormLayout,
} from "./OnboardingCommon";

export const MicPermsForm = () => {
  const micPermission = useAppStore((state) => state.permissions.microphone);
  const requestLifecycle = useAppStore(
    (state) => state.permissionRequests.microphone,
  );
  const gateState = useMemo(
    () =>
      derivePermissionGateState({
        kind: "microphone",
        status: micPermission,
        requestInFlight: requestLifecycle.requestInFlight,
        awaitingExternalApproval: requestLifecycle.awaitingExternalApproval,
      }),
    [micPermission, requestLifecycle],
  );
  const isAuthorized = isPermissionAuthorized(micPermission?.state);

  const handleAllow = useCallback(async () => {
    const latestState = useAppStore.getState();
    const latestGateState = derivePermissionGateState({
      kind: "microphone",
      status: latestState.permissions.microphone,
      requestInFlight:
        latestState.permissionRequests.microphone.requestInFlight,
      awaitingExternalApproval:
        latestState.permissionRequests.microphone.awaitingExternalApproval,
    });

    if (!latestGateState.canRequest) {
      return;
    }

    trackButtonClick("onboarding_mic_allow_access");
    produceAppState((draft) => {
      draft.permissionRequests.microphone.requestInFlight = true;
    });
    try {
      const result = await requestMicrophonePermission();
      produceAppState((draft) => {
        draft.permissions.microphone = result;
        draft.permissionRequests.microphone = resolvePermissionRequestLifecycle(
          {
            kind: "microphone",
            status: result,
            requestInFlight:
              draft.permissionRequests.microphone.requestInFlight,
            awaitingExternalApproval:
              draft.permissionRequests.microphone.awaitingExternalApproval,
          },
        );
      });
    } catch (error) {
      console.error("Failed to request microphone permission", error);
      produceAppState((draft) => {
        draft.permissionRequests.microphone.requestInFlight = false;
      });
    }
  }, []);

  const handleContinue = () => {
    trackButtonClick("onboarding_mic_perms_continue");
    goToOnboardingPage("a11yPerms");
  };

  const form = (
    <OnboardingFormLayout
      back={<BackButton />}
      actions={
        <Button
          variant="contained"
          endIcon={<ArrowForward />}
          onClick={handleContinue}
          disabled={!isAuthorized}
        >
          <FormattedMessage defaultMessage="Continue" />
        </Button>
      }
    >
      <Stack spacing={3}>
        <Box>
          <Typography variant="h4" fontWeight={600} pb={1}>
            <FormattedMessage defaultMessage="Set up your microphone" />
          </Typography>
          <Typography variant="body1" color="text.secondary">
            <FormattedMessage defaultMessage="Voquill only activates your microphone when you choose to start recording." />
          </Typography>
        </Box>

        {isAuthorized ? (
          <Button
            variant="outlined"
            color="success"
            startIcon={<Check />}
            disabled
            sx={{ alignSelf: "flex-start" }}
          >
            <FormattedMessage defaultMessage="Access granted" />
          </Button>
        ) : (
          <Button
            variant="outlined"
            onClick={() => void handleAllow()}
            disabled={!gateState.canRequest}
            endIcon={
              requestLifecycle.requestInFlight ? undefined : <OpenInNew />
            }
            sx={{ alignSelf: "flex-start" }}
          >
            {requestLifecycle.requestInFlight ? (
              <FormattedMessage defaultMessage="Requesting" />
            ) : gateState.shouldOpenSettings ? (
              <FormattedMessage defaultMessage="Open settings" />
            ) : (
              <FormattedMessage defaultMessage="Allow access" />
            )}
          </Button>
        )}
      </Stack>
    </OnboardingFormLayout>
  );

  const rightContent = (
    <Box
      sx={{
        borderRadius: "24px",
        border: "1px solid gray",
        overflow: "hidden",
        maxHeight: "100%",
        margin: 8,
      }}
    >
      <Box
        component="video"
        src={enableMicVideo}
        autoPlay
        loop
        muted
        playsInline
        sx={{
          display: "block",
          margin: "-10px",
          width: "auto",
          height: "auto",
          maxWidth: "calc(100% + 20px)",
          maxHeight: "calc(100% + 20px)",
        }}
      />
    </Box>
  );

  return (
    <DualPaneLayout
      left={form}
      right={rightContent}
      rightSx={{
        bgcolor: "transparent",
      }}
    />
  );
};
