import { getVersion } from "@tauri-apps/api/app";
import { invoke } from "@tauri-apps/api/core";
import {
  EnterpriseConfig,
  EnterpriseLicense,
  Member,
  Nullable,
  User,
} from "@voquill/types";
import { getRec, listify } from "@voquill/utilities";
import dayjs from "dayjs";
import { isEqual } from "lodash-es";
import { useEffect, useRef, useState } from "react";
import { combineLatest, from, Observable, of } from "rxjs";
import { showErrorSnackbar, showSnackbar } from "../../actions/app.actions";
import { ensureRustSessionSync } from "../../actions/login.actions";
import { loadPairedRemoteDevices } from "../../actions/paired-remote-device.actions";
import { openUpgradePlanDialog } from "../../actions/pricing.actions";
import {
  refreshRemoteReceiverStatus,
  startRemoteReceiver,
} from "../../actions/remote-receiver.actions";
import { handleRemoteFinalTextReceived } from "../../actions/remote-transcript.actions";
import {
  checkForAppUpdates,
  dismissUpdateDialog,
  installAvailableUpdate,
} from "../../actions/updater.actions";
import {
  migrateLocalUserToCloud,
  refreshCurrentUser,
  setRemoteOutputEnabled,
  setRemoteTargetDeviceId,
} from "../../actions/user.actions";
import { useAsyncData, useAsyncEffect } from "../../hooks/async.hooks";
import { useIntervalAsync, useKeyDownHandler } from "../../hooks/helper.hooks";
import { useHotkeyFire } from "../../hooks/hotkey.hooks";
import { useStreamWithSideEffects } from "../../hooks/stream.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { detectLocale } from "../../i18n";
import {
  getAuthRepo,
  getConfigRepo,
  getEnterpriseRepo,
  getMemberRepo,
  getUserRepo,
} from "../../repos";
import { HotkeyStrategy, PasteKeybindSupport } from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AuthUser } from "../../types/auth.types";
import { OverlayPhase } from "../../types/overlay.types";
import { CURRENT_COHORT, getMixpanel } from "../../utils/analytics.utils";
import { registerMembers, registerUsers } from "../../utils/app.utils";
import {
  getEnterpriseTarget,
  invokeEnterprise,
  loadEnterpriseTarget,
} from "../../utils/enterprise.utils";
import { getIsDevMode } from "../../utils/env.utils";
import { addSelectedTextToDictionary } from "../../actions/dictionary.actions";
import { ADD_TO_DICTIONARY_HOTKEY } from "../../utils/keyboard.utils";
import { DASHBOARD_SECTION_PATHS } from "../../utils/dashboard-navigation.utils";
import { getLogger, initLogging } from "../../utils/log.utils";
import { isPermissionAuthorized } from "../../utils/permission.utils";
import { getPlatform } from "../../utils/platform.utils";
import { minutesToMilliseconds } from "../../utils/time.utils";
import {
  getEffectivePillVisibility,
  getMyUserPreferences,
  LOCAL_USER_ID,
} from "../../utils/user.utils";
import {
  consumeSurfaceWindowFlag,
  surfaceMainWindow,
} from "../../utils/window.utils";

type StreamRet = Nullable<[Nullable<Member>, Nullable<User>]>;

type KeysHeldPayload = {
  keys: string[];
};

type OverlayPhasePayload = {
  phase: OverlayPhase;
};

type RecordingLevelPayload = {
  levels?: number[];
};

type BridgeHotkeyTriggerPayload = {
  hotkey: string;
};

type RemoteFinalTextReceivedPayload = {
  senderDeviceId: string;
  eventId: string;
  text: string;
  mode: string;
  createdAt: string;
};

// Timeout for Firebase Auth initialization (handles cases where IndexedDB hangs on some Linux systems)
const AUTH_READY_TIMEOUT_MS = 4_000;

// 10 minutes
const CONFIG_REFRESH_INTERVAL_MS = 1000 * 60 * 10;

// 5 minutes
const TOKEN_REFRESH_INTERVAL_MS = 5 * 60 * 1000;

// 60 seconds
const ENTERPRISE_REFRESH_INTERVAL_MS = 1000 * 60;

export const AppSideEffects = () => {
  const [authReady, setAuthReady] = useState(false);
  const [streamReady, setStreamReady] = useState(false);
  const [initReady, setInitReady] = useState(false);
  const [enterpriseReady, setEnterpriseReady] = useState(false);
  const tokensRefreshedRef = useRef(false);
  const authReadyRef = useRef(false);
  const isEnterprise = useAppStore((state) => state.isEnterprise);
  const updateInitializedRef = useRef(false);
  const versionData = useAsyncData(getVersion, []);
  const allowDevTools = useAppStore(
    (state) => state.enterpriseConfig?.allowDevTools ?? true,
  );
  const userId = useAppStore((state) => state.auth?.uid ?? "");
  const initialized = useAppStore((state) => state.initialized);
  const member = useAppStore((state) => {
    const uid = state.auth?.uid;
    return uid ? (state.memberById[uid] ?? null) : null;
  });
  const localUser = useAppStore(
    (state) => state.userById[LOCAL_USER_ID] ?? null,
  );
  const cloudUser = useAppStore((state) => {
    const uid = state.auth?.uid;
    return uid ? (state.userById[uid] ?? null) : null;
  });
  const prefs = useAppStore((state) => getMyUserPreferences(state));
  const keyPermAuthorized = useAppStore((state) =>
    isPermissionAuthorized(getRec(state.permissions, "accessibility")?.state),
  );

  const hotkeyStrategy = useAppStore((state) => state.hotkeyStrategy);

  useAsyncEffect(async () => {
    const [strategy, appDetection, pasteKeybinds] = await Promise.all([
      invoke<HotkeyStrategy>("get_hotkey_strategy"),
      invoke<boolean>("supports_app_detection"),
      invoke<PasteKeybindSupport>("supports_paste_keybinds"),
    ]);
    produceAppState((draft) => {
      draft.hotkeyStrategy = strategy;
      draft.supportsAppDetection = appDetection;
      draft.supportsPasteKeybinds = pasteKeybinds;
    });
  }, []);

  useAsyncEffect(async () => {
    if (hotkeyStrategy !== "listener") {
      return;
    }

    if (keyPermAuthorized) {
      getLogger().info(
        "Accessibility permission authorized, starting key listener",
      );
      await invoke("start_key_listener");
    } else {
      getLogger().info(
        "Accessibility permission not authorized, stopping key listener",
      );
      await invoke("stop_key_listener");
    }
  }, [keyPermAuthorized, hotkeyStrategy]);

  useEffect(() => {
    void initLogging();
  }, []);

  useAsyncEffect(async () => {
    if (consumeSurfaceWindowFlag()) {
      await surfaceMainWindow();
    }
  }, []);

  useAsyncEffect(async () => {
    await ensureRustSessionSync();
  }, []);

  const onAuthStateChanged = (user: AuthUser | null) => {
    getLogger().info(`Auth state changed (uid=${user?.uid ?? "none"})`);
    authReadyRef.current = true;
    setAuthReady(true);
    produceAppState((draft) => {
      draft.auth = user;
      draft.initialized = false;
    });
  };

  useTauriListen<OverlayPhasePayload>("overlay_phase", (payload) => {
    produceAppState((draft) => {
      draft.overlayPhase = payload.phase;
      if (payload.phase !== "recording") {
        draft.audioLevels = [];
      }
    });
  });

  useTauriListen<RecordingLevelPayload>("recording_level", (payload) => {
    const raw = Array.isArray(payload.levels) ? payload.levels : [];
    const sanitized = raw.map((value) =>
      typeof value === "number" && Number.isFinite(value) ? value : 0,
    );

    produceAppState((draft) => {
      draft.audioLevels = sanitized;
    });
  });

  useTauriListen<BridgeHotkeyTriggerPayload>(
    "bridge_hotkey_trigger",
    (payload) => {
      produceAppState((draft) => {
        draft.hotkeyTriggers[payload.hotkey] =
          (draft.hotkeyTriggers[payload.hotkey] ?? 0) + 1;
      });
    },
  );

  useTauriListen<KeysHeldPayload>("keys_held", (payload) => {
    const existing = getAppState().keysHeld;
    if (isEqual(existing, payload.keys)) {
      return;
    }

    produceAppState((draft) => {
      draft.keysHeld = payload.keys;
    });
  });

  useTauriListen<RemoteFinalTextReceivedPayload>(
    "remote_final_text_received",
    async (payload) => {
      await handleRemoteFinalTextReceived(payload);
      await refreshRemoteReceiverStatus().catch(() => undefined);
    },
  );

  useEffect(() => {
    if (allowDevTools) {
      return;
    }

    const handler = (e: MouseEvent) => e.preventDefault();
    document.addEventListener("contextmenu", handler);
    return () => document.removeEventListener("contextmenu", handler);
  }, [isEnterprise, allowDevTools]);

  useEffect(() => {
    authReadyRef.current = false;

    const timeoutId = setTimeout(() => {
      if (!authReadyRef.current) {
        getLogger().warning("Auth timed out, proceeding without auth");
        onAuthStateChanged(null);
      }
    }, AUTH_READY_TIMEOUT_MS);

    const unsubscribe = getAuthRepo().onAuthStateChanged(
      onAuthStateChanged,
      (error) => {
        showErrorSnackbar(error);
        onAuthStateChanged(null);
      },
    );

    return () => {
      clearTimeout(timeoutId);
      unsubscribe();
    };
  }, [isEnterprise]);

  useIntervalAsync(CONFIG_REFRESH_INTERVAL_MS, async () => {
    const config = await getConfigRepo()
      .getFullConfig()
      .catch(() => null);

    if (config) {
      produceAppState((draft) => {
        draft.config = config;
      });
    }
  }, []);

  useIntervalAsync(ENTERPRISE_REFRESH_INTERVAL_MS, async () => {
    getLogger().verbose("Loading enterprise target");
    const debugInfo = await loadEnterpriseTarget();

    getLogger().verbose(
      "Enterprise target reloaded from",
      debugInfo,
      getEnterpriseTarget(),
    );

    let config: Nullable<EnterpriseConfig> = null;
    let license: Nullable<EnterpriseLicense> = null;
    let isEnterprise = false;

    const repo = getEnterpriseRepo();
    if (repo) {
      isEnterprise = true;
      [config, license] = await repo.getConfig().catch((e) => {
        getLogger().error(`Failed to refresh enterprise config: ${e}`);
        return [null, null];
      });
    }

    const oidcProviders = isEnterprise
      ? await invokeEnterprise("oidcProvider/listEnabled", {})
          .then((res) => res.providers)
          .catch(() => [])
      : [];

    produceAppState((draft) => {
      draft.enterpriseConfig = config;
      draft.enterpriseLicense = license;
      draft.isEnterprise = isEnterprise;
      draft.oidcProviders = oidcProviders;
    });

    if (!tokensRefreshedRef.current) {
      tokensRefreshedRef.current = true;
      await getAuthRepo().refreshTokens();
    }

    setEnterpriseReady(true);
  }, []);

  useIntervalAsync(TOKEN_REFRESH_INTERVAL_MS, async () => {
    await getAuthRepo().refreshTokens();
  }, []);

  useStreamWithSideEffects({
    builder: (): Observable<StreamRet> => {
      if (!authReady) {
        return of(null);
      }

      if (!userId) {
        return combineLatest([of(null), of(null)]);
      }

      return combineLatest([
        from(
          getMemberRepo()
            .getMyMember()
            .catch(() => null),
        ),
        from(
          getUserRepo()
            .getMyUser()
            .catch(() => null),
        ),
      ]);
    },
    onSuccess: (results) => {
      setStreamReady(true);
      if (results === null) {
        return;
      }

      const [members, user] = results;
      produceAppState((draft) => {
        registerUsers(draft, listify(user));
        registerMembers(draft, listify(members));
      });
    },
    dependencies: [userId, authReady, isEnterprise],
  });

  useAsyncEffect(async () => {
    if (authReady) {
      await refreshCurrentUser();
      setInitReady(true);
    }
  }, [authReady, isEnterprise]);

  useAsyncEffect(async () => {
    if (initReady) {
      await loadPairedRemoteDevices();
      await refreshRemoteReceiverStatus();
      const prefs = getMyUserPreferences(getAppState());
      if (
        prefs?.remoteTargetDeviceId &&
        !getAppState().pairedRemoteDeviceById[prefs.remoteTargetDeviceId]
      ) {
        await setRemoteTargetDeviceId(null);
        await setRemoteOutputEnabled(false);
      }
      const receiverStatus = getAppState().remoteReceiverStatus;
      if (prefs?.remoteReceiverAutoStart && !receiverStatus?.enabled) {
        await startRemoteReceiver(prefs.remoteReceiverPort ?? null);
      }
    }
  }, [initReady]);

  useEffect(() => {
    if (streamReady && initReady && !initialized && enterpriseReady) {
      getLogger().info("App fully initialized");
      produceAppState((draft) => {
        draft.initialized = true;
      });
    }
  }, [streamReady, initReady, initialized, enterpriseReady]);

  const isMigratingLocalUserRef = useRef(false);
  const memberPlan = member?.plan;
  useEffect(() => {
    if (!userId || !memberPlan) {
      return;
    }

    if (memberPlan !== "free" && memberPlan !== "pro") {
      return;
    }

    if (!localUser || cloudUser || isMigratingLocalUserRef.current) {
      return;
    }

    isMigratingLocalUserRef.current = true;
    getLogger().info("Migrating local user to cloud");
    (async () => {
      try {
        await migrateLocalUserToCloud();
        getLogger().info("Local user migrated to cloud successfully");
      } catch (error) {
        getLogger().error(`Failed to migrate local user to cloud: ${error}`);
        showErrorSnackbar(error);
      } finally {
        isMigratingLocalUserRef.current = false;
      }
    })();
  }, [userId, memberPlan, localUser, cloudUser]);

  const auth = useAppStore((state) => state.auth);
  const prevUserIdRef = useRef<string | null>(null);
  useEffect(() => {
    if (!initialized) {
      return;
    }

    const mp = getMixpanel();
    if (!mp) {
      return;
    }

    const currentUserId = auth?.uid ?? null;
    const prevUserId = prevUserIdRef.current;
    if (prevUserId && !currentUserId) {
      mp.reset();
    }

    const isPro = member?.plan === "pro";
    const isFree = member?.plan === "free";
    const isCommunity = !currentUserId;
    const isTrial = member?.isOnTrial ?? false;
    const isPaying = !isTrial && isPro;
    const onboardedAt = cloudUser?.onboardedAt ?? localUser?.onboardedAt;
    const daysSinceOnboarded = onboardedAt
      ? dayjs().diff(dayjs(onboardedAt), "day")
      : 0;
    const platform = getPlatform();
    const locale = detectLocale();
    const onboarded = cloudUser?.onboarded ?? localUser?.onboarded ?? false;
    const planStatus = member?.plan ?? "community";

    if (currentUserId && currentUserId !== prevUserId) {
      mp.identify(currentUserId);

      mp.people.set_once({
        $created: new Date().toISOString(),
        initialPlatform: platform,
        initialLocale: locale,
        initialCohort: CURRENT_COHORT,
      });

      mp.register_once({
        initialPlatform: platform,
        initialLocale: locale,
        initialCohort: CURRENT_COHORT,
      });
    }

    mp.people.set({
      $email: auth?.email ?? undefined,
      $name: auth?.displayName ?? undefined,
      planStatus,
      isPro,
      isFree,
      isCommunity,
      isTrial,
      isPaying,
      onboarded,
      onboardedAt: onboardedAt ?? undefined,
      activeSystemCohort: CURRENT_COHORT,
      daysSinceOnboarded,
      pillState: getEffectivePillVisibility(prefs?.dictationPillVisibility),
      company: cloudUser?.company ?? undefined,
      title: cloudUser?.title ?? undefined,
      referralSource: cloudUser?.referralSource ?? undefined,
      isEnterprise,
    });

    mp.register({
      userId: currentUserId,
      planStatus,
      isPro,
      isFree,
      isCommunity,
      platform,
      locale,
      onboarded,
      daysSinceOnboarded,
      activeSystemCohort: CURRENT_COHORT,
      pillState: getEffectivePillVisibility(prefs?.dictationPillVisibility),
    });

    if (versionData.state === "success") {
      mp.register({
        appVersion: versionData.data,
      });
    }

    prevUserIdRef.current = currentUserId;
  }, [
    initialized,
    auth,
    member,
    cloudUser,
    localUser,
    prefs,
    versionData,
    isEnterprise,
  ]);

  useHotkeyFire({
    actionName: ADD_TO_DICTIONARY_HOTKEY,
    isDisabled: false,
    onFire: addSelectedTextToDictionary,
  });

  // You cannot refresh the page in Tauri, here's a hotkey to help with that
  useKeyDownHandler({
    keys: ["r"],
    ctrl: true,
    callback: () => {
      if (getIsDevMode()) {
        showSnackbar("Refreshing application...");
        window.location.href = "/welcome";
      }
    },
  });

  // Hotkey to open settings (Cmd+, on macOS)
  useKeyDownHandler({
    keys: [","],
    meta: true,
    callback: () => {
      if (window.location.pathname !== DASHBOARD_SECTION_PATHS.settings) {
        window.location.href = DASHBOARD_SECTION_PATHS.settings;
      }
    },
  });

  // check for app updates every minute
  useIntervalAsync(
    minutesToMilliseconds(1),
    async () => {
      if (!updateInitializedRef.current) {
        dismissUpdateDialog();
        updateInitializedRef.current = true;
      }

      await checkForAppUpdates();
    },
    [],
  );

  useToastAction(async (payload) => {
    if (payload.action === "upgrade") {
      surfaceMainWindow();
      openUpgradePlanDialog();
    } else if (payload.action === "open_agent_settings") {
      surfaceMainWindow();
      produceAppState((draft) => {
        draft.settings.agentModeDialogOpen = true;
      });
    } else if (payload.action === "surface_window") {
      surfaceMainWindow();
    }
  });

  useTauriListen<void>("tray-install-update", () => {
    surfaceMainWindow();
    installAvailableUpdate();
  });

  const menuBarIconHidden = prefs?.menuBarIconHidden ?? false;
  useEffect(() => {
    invoke("set_tray_visible", { visible: !menuBarIconHidden }).catch(
      console.error,
    );
  }, [menuBarIconHidden]);

  return null;
};
