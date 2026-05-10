import { useCallback, useEffect, useRef } from "react";
import { useIntervalAsync } from "../../hooks/helper.hooks";
import { produceAppState } from "../../store";
import { resolvePermissionRequestLifecycle } from "../../utils/permission-flow.utils";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
  checkScreenRecordingPermission,
} from "../../utils/permission.utils";

export const PermissionSideEffects = () => {
  const mountedRef = useRef(true);
  const checkingRef = useRef(false);

  const refreshPermissions = useCallback(async () => {
    if (checkingRef.current) {
      return;
    }

    checkingRef.current = true;
    try {
      const [microphone, accessibility, screenRecording] = await Promise.all([
        checkMicrophonePermission().catch((error) => {
          console.error("Failed to fetch microphone permission", error);
          return null;
        }),
        checkAccessibilityPermission().catch((error) => {
          console.error("Failed to fetch accessibility permission", error);
          return null;
        }),
        checkScreenRecordingPermission().catch((error) => {
          console.error("Failed to fetch screen-recording permission", error);
          return null;
        }),
      ]);

      if (mountedRef.current) {
        produceAppState((draft) => {
          if (microphone) {
            draft.permissions.microphone = microphone;
            if (!draft.permissionRequests.microphone.requestInFlight) {
              draft.permissionRequests.microphone =
                resolvePermissionRequestLifecycle({
                  kind: "microphone",
                  status: microphone,
                  requestInFlight:
                    draft.permissionRequests.microphone.requestInFlight,
                  awaitingExternalApproval:
                    draft.permissionRequests.microphone
                      .awaitingExternalApproval,
                });
            }
          }

          if (accessibility) {
            draft.permissions.accessibility = accessibility;
            if (!draft.permissionRequests.accessibility.requestInFlight) {
              draft.permissionRequests.accessibility =
                resolvePermissionRequestLifecycle({
                  kind: "accessibility",
                  status: accessibility,
                  requestInFlight:
                    draft.permissionRequests.accessibility.requestInFlight,
                  awaitingExternalApproval:
                    draft.permissionRequests.accessibility
                      .awaitingExternalApproval,
                });
            }
          }

          if (screenRecording) {
            draft.permissions["screen-recording"] = screenRecording;
            if (!draft.permissionRequests["screen-recording"].requestInFlight) {
              draft.permissionRequests["screen-recording"] =
                resolvePermissionRequestLifecycle({
                  kind: "screen-recording",
                  status: screenRecording,
                  requestInFlight:
                    draft.permissionRequests["screen-recording"].requestInFlight,
                  awaitingExternalApproval:
                    draft.permissionRequests["screen-recording"]
                      .awaitingExternalApproval,
                });
            }
          }
        });
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    void refreshPermissions();
    return () => {
      mountedRef.current = false;
    };
  }, [refreshPermissions]);

  useIntervalAsync(1000, refreshPermissions, [refreshPermissions]);

  return null;
};
