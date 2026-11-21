import { useCallback, useEffect, useRef } from "react";
import { produceAppState, useAppStore } from "../../store";
import {
  checkAccessibilityPermission,
  checkMicrophonePermission,
  isPermissionAuthorized,
  REQUIRED_PERMISSIONS,
} from "../../utils/permission.utils";

export const PermissionSideEffects = () => {
  const mountedRef = useRef(true);
  const checkingRef = useRef(false);
  const windowFocused = useAppStore((state) => state.windowFocused);
  const allAuthorized = useAppStore((state) =>
    REQUIRED_PERMISSIONS.every((kind) =>
      isPermissionAuthorized(state.permissions[kind]?.state),
    ),
  );

  const refreshPermissions = useCallback(async () => {
    if (checkingRef.current) {
      return;
    }

    checkingRef.current = true;
    try {
      const [microphone, accessibility] = await Promise.all([
        checkMicrophonePermission().catch((error) => {
          console.error("Failed to fetch microphone permission", error);
          return null;
        }),
        checkAccessibilityPermission().catch((error) => {
          console.error("Failed to fetch accessibility permission", error);
          return null;
        }),
      ]);

      if (mountedRef.current) {
        produceAppState((draft) => {
          draft.permissions.microphone = microphone;
          draft.permissions.accessibility = accessibility;
        });
      }
    } finally {
      checkingRef.current = false;
    }
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (windowFocused) {
      void refreshPermissions();
    }
  }, [windowFocused, refreshPermissions]);

  useEffect(() => {
    if (allAuthorized) {
      return;
    }
    const interval = setInterval(() => void refreshPermissions(), 1000);
    return () => clearInterval(interval);
  }, [allAuthorized, refreshPermissions]);

  return null;
};
