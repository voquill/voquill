import { invoke } from "@tauri-apps/api/core";
import { Nullable, Tone } from "@voquill/types";
import { useCallback } from "react";
import { browserRouter } from "../../router";
import {
  setPreferredMicrophone,
  setPreferredPostProcessingApiKeyId,
  setPreferredPostProcessingMode,
  setPreferredTranscriptionApiKeyId,
  setPreferredTranscriptionMode,
} from "../../actions/user.actions";
import { setActiveTone } from "../../actions/tone.actions";
import { useAsyncEffect } from "../../hooks/async.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { getAppState, useAppStore } from "../../store";
import { resolveDashboardSectionPath } from "../../utils/dashboard-navigation.utils";
import { getLogger } from "../../utils/log.utils";
import { getActiveManualToneIds } from "../../utils/tone.utils";
import { surfaceMainWindow } from "../../utils/window.utils";

type InputDeviceDescriptor = {
  label: string;
  isDefault: boolean;
  caution: boolean;
};

type TrayMenuItemConfig = {
  id: string;
  label: string;
  checked: boolean;
};

type TrayMenuConfig = {
  updateAvailable: boolean;
  microphones: TrayMenuItemConfig[];
  tones: TrayMenuItemConfig[];
  transcriptionProviders: TrayMenuItemConfig[];
  postProcessingProviders: TrayMenuItemConfig[];
};

const AUTO_OPTION_VALUE = "__microphone_auto__";

const buildTrayMenuConfig = async (
  preferredMicrophone: Nullable<string>,
  toneById: Record<string, Tone>,
  activeToneId: Nullable<string>,
  transcriptionMode: Nullable<string>,
  transcriptionApiKeyId: Nullable<string>,
  postProcessingMode: Nullable<string>,
  postProcessingApiKeyId: Nullable<string>,
  apiKeys: Array<{ id: string; name: string }>,
  updateAvailable: boolean,
): Promise<TrayMenuConfig> => {
  let microphones: TrayMenuItemConfig[] = [];
  try {
    const devices = await invoke<InputDeviceDescriptor[]>("list_microphones");
    microphones = [
      {
        id: AUTO_OPTION_VALUE,
        label: "Automatic",
        checked: !preferredMicrophone,
      },
      ...devices.map((device) => ({
        id: device.label,
        label: device.label,
        checked: preferredMicrophone === device.label,
      })),
    ];
  } catch {
    // Ignore microphone enumeration errors
  }

  const tones = getActiveManualToneIds(getAppState())
    .map((id) => toneById[id])
    .filter((tone): tone is Tone => tone !== undefined)
    .map((tone) => ({
      id: tone.id,
      label: tone.name,
      checked: activeToneId === tone.id,
    }));

  const transcriptionProviders: TrayMenuItemConfig[] = [
    { id: "cloud", label: "Cloud", checked: transcriptionMode === "cloud" },
    ...apiKeys.map((key) => ({
      id: `api:${key.id}`,
      label: key.name,
      checked: transcriptionMode === "api" && transcriptionApiKeyId === key.id,
    })),
    { id: "local", label: "Local", checked: transcriptionMode === "local" },
  ];

  const postProcessingProviders: TrayMenuItemConfig[] = [
    { id: "cloud", label: "Cloud", checked: postProcessingMode === "cloud" },
    ...apiKeys.map((key) => ({
      id: `api:${key.id}`,
      label: key.name,
      checked:
        postProcessingMode === "api" && postProcessingApiKeyId === key.id,
    })),
    { id: "none", label: "None", checked: postProcessingMode === "none" },
  ];

  return {
    updateAvailable,
    microphones,
    tones,
    transcriptionProviders,
    postProcessingProviders,
  };
};

export const TrayMenuSideEffects = () => {
  const initialized = useAppStore((state) => state.initialized);
  const preferredMicrophone = useAppStore(
    (state) => state.userPrefs?.preferredMicrophone ?? null,
  );
  const toneById = useAppStore((state) => state.toneById);
  const activeToneId = useAppStore(
    (state) => state.userPrefs?.activeToneId ?? null,
  );
  const transcriptionMode = useAppStore(
    (state) => state.settings.aiTranscription.mode,
  );
  const transcriptionApiKeyId = useAppStore(
    (state) => state.settings.aiTranscription.selectedApiKeyId,
  );
  const postProcessingMode = useAppStore(
    (state) => state.settings.aiPostProcessing.mode,
  );
  const postProcessingApiKeyId = useAppStore(
    (state) => state.settings.aiPostProcessing.selectedApiKeyId,
  );
  const apiKeys = useAppStore((state) => state.settings.apiKeys);
  const updateAvailable = useAppStore(
    (state) => state.updater.status === "ready",
  );
  const transcriptionIds = useAppStore(
    (state) => state.transcriptions.transcriptionIds,
  );
  const transcriptionById = useAppStore((state) => state.transcriptionById);

  const syncTrayMenu = useCallback(async () => {
    if (!initialized) {
      return;
    }
    const config = await buildTrayMenuConfig(
      preferredMicrophone,
      toneById,
      activeToneId,
      transcriptionMode,
      transcriptionApiKeyId,
      postProcessingMode,
      postProcessingApiKeyId,
      apiKeys,
      updateAvailable,
    );
    try {
      await invoke("rebuild_tray_menu", { config });
    } catch (error) {
      getLogger().verbose(`Failed to rebuild tray menu: ${error}`);
    }
  }, [
    initialized,
    preferredMicrophone,
    toneById,
    activeToneId,
    transcriptionMode,
    transcriptionApiKeyId,
    postProcessingMode,
    postProcessingApiKeyId,
    apiKeys,
    updateAvailable,
  ]);

  useAsyncEffect(async () => {
    await syncTrayMenu();
  }, [syncTrayMenu]);

  useTauriListen<string>("tray-navigate", async (route) => {
    const path = resolveDashboardSectionPath(route);
    if (!path) {
      getLogger().warning(`Unknown tray route: ${route}`);
      return;
    }
    await browserRouter.navigate(path);
    await surfaceMainWindow();
  });

  useTauriListen<void>("tray-copy-last-transcription", () => {
    const latestId = transcriptionIds[0];
    const transcript = transcriptionById[latestId]?.transcript ?? "";
    if (!transcript) {
      return;
    }
    invoke("copy_to_clipboard", { text: transcript }).catch((error) => {
      getLogger().error(`Failed to copy transcription: ${error}`);
    });
  });

  useTauriListen<string>("tray-select-microphone", (micId) => {
    const normalized = micId === AUTO_OPTION_VALUE ? null : micId;
    setPreferredMicrophone(normalized).catch((error) => {
      getLogger().error(`Failed to set microphone: ${error}`);
    });
  });

  useTauriListen<string>("tray-select-tone", (toneId) => {
    setActiveTone(toneId).catch((error) => {
      getLogger().error(`Failed to set tone: ${error}`);
    });
  });

  useTauriListen<string>("tray-select-transcription-provider", (providerId) => {
    if (providerId.startsWith("api:")) {
      const keyId = providerId.slice(4);
      setPreferredTranscriptionMode("api")
        .then(() => setPreferredTranscriptionApiKeyId(keyId))
        .catch((error) => {
          getLogger().error(`Failed to set transcription provider: ${error}`);
        });
    } else {
      setPreferredTranscriptionMode(providerId as "cloud" | "local").catch(
        (error) => {
          getLogger().error(`Failed to set transcription provider: ${error}`);
        },
      );
    }
  });

  useTauriListen<string>(
    "tray-select-post-processing-provider",
    (providerId) => {
      if (providerId.startsWith("api:")) {
        const keyId = providerId.slice(4);
        setPreferredPostProcessingMode("api")
          .then(() => setPreferredPostProcessingApiKeyId(keyId))
          .catch((error) => {
            getLogger().error(
              `Failed to set post-processing provider: ${error}`,
            );
          });
      } else {
        setPreferredPostProcessingMode(providerId as "cloud" | "none").catch(
          (error) => {
            getLogger().error(
              `Failed to set post-processing provider: ${error}`,
            );
          },
        );
      }
    },
  );

  return null;
};
