import {
  type AgentMode,
  DictationPillVisibility,
  Nullable,
  StylingMode,
  User,
  UserPreferences,
} from "@voquill/types";
import dayjs from "dayjs";
import { getIntl } from "../i18n";
import { getUserPreferencesRepo, getUserRepo } from "../repos";
import { CloudUserRepo } from "../repos/user.repo";
import { getAppState, produceAppState } from "../store";
import {
  type PostProcessingMode,
  type TranscriptionMode,
} from "../types/ai.types";
import { AsyncLock } from "../utils/async-lock.utils";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  normalizeDictationLimitMinutes,
} from "../utils/dictation-limit.utils";
import { getIsEnterpriseEnabled } from "../utils/enterprise.utils";
import { PRIMARY_LANGUAGE_SENTINEL } from "../utils/language.utils";
import {
  isGpuPreferredTranscriptionDevice,
  normalizeLocalWhisperModel,
  normalizeTranscriptionDevice,
  supportsGpuTranscriptionDevice,
} from "../utils/local-transcription.utils";
import { getLogger } from "../utils/log.utils";
import { sendPillFireworks, sendPillFlame } from "../utils/overlay.utils";
import {
  getMyEffectiveUserId,
  getMyUser,
  getMyUserPreferences,
  LOCAL_USER_ID,
  setCurrentUser,
  setUserPreferences,
} from "../utils/user.utils";
import { showErrorSnackbar } from "./app.actions";
import { setLocalStorageValue } from "./local-storage.actions";

const userSaveLock = new AsyncLock();

const updateUser = async (
  updateCallback: (user: User) => void,
  errorMessage: string,
  saveErrorMessage: string,
): Promise<void> => {
  const state = getAppState();
  const existing = getMyUser(state);
  if (!existing) {
    getLogger().warning(`updateUser: user not found (${errorMessage})`);
    showErrorSnackbar(errorMessage);
    return;
  }

  const repo = getUserRepo();
  const payload: User = {
    ...existing,
    updatedAt: new Date().toISOString(),
  };

  updateCallback(payload);
  produceAppState((draft) => {
    setCurrentUser(draft, payload);
  });

  await userSaveLock.run(async () => {
    try {
      getLogger().verbose(`Saving user (id=${payload.id})`);
      await repo.setMyUser(payload);
      getLogger().verbose("User saved successfully");
    } catch (error) {
      getLogger().error(`Failed to update user: ${error}`);
      produceAppState((draft) => {
        setCurrentUser(draft, existing);
      });
      showErrorSnackbar(saveErrorMessage);
      throw error;
    }
  });
};

export const createDefaultPreferences = (): UserPreferences => ({
  userId: LOCAL_USER_ID,
  transcriptionMode: null,
  transcriptionApiKeyId: null,
  transcriptionDevice: null,
  transcriptionModelSize: null,
  postProcessingMode: null,
  postProcessingApiKeyId: null,
  postProcessingOllamaUrl: null,
  postProcessingOllamaModel: null,
  activeToneId: null,
  gotStartedAt: null,
  gpuEnumerationEnabled: false,
  agentMode: null,
  agentModeApiKeyId: null,
  openclawGatewayUrl: null,
  openclawToken: null,
  lastSeenFeature: null,
  isEnterprise: false,
  activeDictationLanguage: PRIMARY_LANGUAGE_SENTINEL,
  preferredMicrophone: null,
  ignoreUpdateDialog: false,
  incognitoModeEnabled: false,
  incognitoModeIncludeInStats: false,
  dictationLimitMinutes: DEFAULT_DICTATION_LIMIT_MINUTES,
  dictationPillVisibility: "while_active",
  realtimeOutputEnabled: false,
  remoteOutputEnabled: false,
  remoteTargetDeviceId: null,
  remoteReceiverPort: null,
  remoteReceiverAutoStart: false,
  dictationAudioDim: 1.0,
  pasteKeybind: null,
  menuBarIconHidden: false,
  insertionMethod: null,
  typingSpeedMs: null,
});

export const updateUserPreferences = async (
  updateCallback: (preferences: UserPreferences) => void,
  saveErrorMessage = "Failed to save AI preferences. Please try again.",
): Promise<void> => {
  const state = getAppState();
  const myUserId = getMyEffectiveUserId(state);

  let existing = getMyUserPreferences(state);
  if (!existing) {
    try {
      existing = await getUserPreferencesRepo().getUserPreferences();
    } catch (error) {
      getLogger().error(
        `Failed to load existing preferences before update: ${error}`,
      );
      showErrorSnackbar(saveErrorMessage);
      throw error;
    }
  }

  const safeExisting = existing ?? createDefaultPreferences();
  const payload: UserPreferences = { ...safeExisting, userId: myUserId };
  updateCallback(payload);

  try {
    getLogger().verbose(`Saving user preferences (userId=${myUserId})`);
    const saved = await getUserPreferencesRepo().setUserPreferences(payload);
    produceAppState((draft) => {
      setUserPreferences(draft, saved);
    });
    getLogger().verbose("User preferences saved successfully");
  } catch (error) {
    getLogger().error(`Failed to update user preferences: ${error}`);
    showErrorSnackbar(saveErrorMessage);
    throw error;
  }
};

const getCurrentUsageMonth = (): string => {
  const now = new Date();
  const year = now.getFullYear();
  const month = `${now.getMonth() + 1}`.padStart(2, "0");
  return `${year}-${month}`;
};

const getCurrentDateString = (): string => dayjs().format("YYYY-MM-DD");

const getYesterdayDateString = (): string =>
  dayjs().subtract(1, "day").format("YYYY-MM-DD");

type StreakInfo = ["flame" | "fireworks", string] | null;

const getStreakInfo = (streak: number): StreakInfo => {
  if (getIsEnterpriseEnabled()) {
    return null;
  }

  const intl = getIntl();

  if (streak === 1) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "Let the streak begin! 🔥" }),
    ];
  }

  if (streak === 2) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "2 days in a row! ✌️" }),
    ];
  }

  if (streak === 3) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "3 days strong! 💪" }),
    ];
  }

  if (streak === 5) {
    return [
      "flame",
      intl.formatMessage({ defaultMessage: "High five! 5 days! 🖐️" }),
    ];
  }

  if (streak === 7) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "A full week! 🎉" }),
    ];
  }

  if (streak === 10) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "Double digits! 🔥" }),
    ];
  }

  if (streak === 30) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "One month! Unstoppable! 🚀" }),
    ];
  }

  if (streak === 50) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "50 days! Legend! 🏆" }),
    ];
  }

  if (streak === 100) {
    return [
      "fireworks",
      intl.formatMessage({ defaultMessage: "100 days! 💯" }),
    ];
  }

  if (streak % 100 === 0) {
    return [
      "fireworks",
      intl.formatMessage(
        { defaultMessage: "{streak} days! Incredible! 🌟" },
        { streak },
      ),
    ];
  }

  if (streak % 10 === 0) {
    return [
      "fireworks",
      intl.formatMessage(
        { defaultMessage: "{streak} day streak! 🎉" },
        { streak },
      ),
    ];
  }

  return null;
};

export const recordStreak = async (): Promise<void> => {
  const state = getAppState();
  const user = getMyUser(state);
  if (!user) {
    return;
  }

  const today = getCurrentDateString();
  if (user.streakRecordedAt === today) {
    return;
  }

  const yesterday = getYesterdayDateString();
  const isConsecutive = user.streakRecordedAt === yesterday;
  const newStreak = isConsecutive ? (user.streak ?? 0) + 1 : 1;

  await updateUser(
    (u) => {
      u.streak = newStreak;
      u.streakRecordedAt = today;
    },
    "Unable to update streak. User not found.",
    "Failed to update streak. Please try again.",
  );

  const info = getStreakInfo(newStreak);
  const isEnabled = !getAppState().local.disablePillRewards;
  if (info && isEnabled) {
    const [mode, message] = info;
    if (mode === "fireworks") {
      sendPillFireworks(message);
    } else {
      sendPillFlame(message);
    }
  }
};

export const addWordsToCurrentUser = async (
  wordCount: number,
): Promise<void> => {
  if (wordCount <= 0) {
    return;
  }

  await updateUser(
    (user) => {
      const currentMonth = getCurrentUsageMonth();
      if (user.wordsThisMonthMonth !== currentMonth) {
        user.wordsThisMonth = 0;
        user.wordsThisMonthMonth = currentMonth;
      }

      user.wordsThisMonth += wordCount;
      user.wordsTotal += wordCount;
    },
    "Unable to update usage. User not found.",
    "Failed to update usage metrics. Please try again.",
  );
};

export const refreshCurrentUser = async (): Promise<void> => {
  await userSaveLock.wait();

  try {
    getLogger().verbose("Refreshing current user and preferences");
    const [userResult, preferencesResult] = await Promise.allSettled([
      getUserRepo().getMyUser(),
      getUserPreferencesRepo().getUserPreferences(),
    ]);

    const user = userResult.status === "fulfilled" ? userResult.value : null;
    const hasPreferencesResult = preferencesResult.status === "fulfilled";
    const preferences = hasPreferencesResult ? preferencesResult.value : null;
    if (userResult.status === "rejected") {
      getLogger().warning(`Failed to refresh user: ${userResult.reason}`);
    }
    if (preferencesResult.status === "rejected") {
      getLogger().warning(
        `Failed to refresh user preferences: ${preferencesResult.reason}`,
      );
    }

    produceAppState((draft) => {
      if (user) {
        setCurrentUser(draft, user);
      }

      if (!hasPreferencesResult) {
        return;
      }

      if (preferences) {
        setUserPreferences(draft, preferences);
      } else {
        draft.userPrefs = null;
      }
    });
    getLogger().verbose(
      `User refreshed (hasUser=${!!user}, hasPrefs=${hasPreferencesResult ? !!preferences : "unavailable"})`,
    );
  } catch (error) {
    getLogger().error(`Failed to refresh user: ${error}`);
  }
};

export const setPreferredMicrophone = async (
  preferredMicrophone: Nullable<string>,
) => {
  const trimmed = preferredMicrophone?.trim() ?? null;
  const normalized = trimmed && trimmed.length > 0 ? trimmed : null;

  await updateUserPreferences((preferences) => {
    preferences.preferredMicrophone = normalized;
  }, "Failed to save microphone preference. Please try again.");
};

export const migratePreferredMicrophoneToPreferences =
  async (): Promise<void> => {
    const state = getAppState();
    const user = getMyUser(state);
    if (!user) {
      return;
    }

    if (user.hasMigratedPreferredMicrophone) {
      return;
    }

    const microphoneToMigrate = user.preferredMicrophone ?? null;
    if (microphoneToMigrate) {
      await updateUserPreferences((preferences) => {
        preferences.preferredMicrophone = microphoneToMigrate;
      }, "Failed to migrate microphone preference.");
    }

    await updateUser(
      (u) => {
        u.hasMigratedPreferredMicrophone = true;
      },
      "Unable to mark microphone as migrated. User not found.",
      "Failed to mark microphone as migrated.",
    );
  };

export const setPreferredLanguage = async (
  language: Nullable<string>,
): Promise<void> => {
  await updateUser(
    (user) => {
      user.preferredLanguage = language;
    },
    "Unable to update preferred language. User not found.",
    "Failed to save preferred language. Please try again.",
  );
};

export const setActiveDictationLanguage = async (
  language: string,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.activeDictationLanguage = language;
  }, "Failed to save active dictation language. Please try again.");
};

export const setInteractionChimeEnabled = async (enabled: boolean) => {
  await updateUser(
    (user) => {
      user.playInteractionChime = enabled;
    },
    "Unable to update interaction chime. User not found.",
    "Failed to save interaction chime preference. Please try again.",
  );
};

export const setUserName = async (name: string): Promise<void> => {
  const normalized = name.trim();

  await updateUser(
    (user) => {
      user.name = normalized;
    },
    "Unable to update username. User not found.",
    "Failed to save username. Please try again.",
  );
};

export const setPreferredTranscriptionMode = async (
  mode: TranscriptionMode,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionMode = mode;
  });
};

export const setAllModesToCloud = async (): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.mode = "cloud";
    draft.settings.aiPostProcessing.mode = "cloud";
    draft.settings.agentMode.mode = "cloud";
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionMode = "cloud";
    preferences.postProcessingMode = "cloud";
    preferences.agentMode = "cloud";
  });
};

export const setPreferredTranscriptionApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiTranscription.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionApiKeyId = id;
  });
};

export const setPreferredTranscriptionDevice = async (
  device: string,
): Promise<void> => {
  const normalizedDevice = normalizeTranscriptionDevice(device);
  const gpuEnumerationEnabled =
    isGpuPreferredTranscriptionDevice(normalizedDevice);

  produceAppState((draft) => {
    draft.settings.aiTranscription.device = normalizedDevice;
    draft.settings.aiTranscription.gpuEnumerationEnabled =
      gpuEnumerationEnabled;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionDevice = normalizedDevice;
    preferences.gpuEnumerationEnabled = gpuEnumerationEnabled;
  });
};

export const setPreferredTranscriptionModelSize = async (
  modelSize: string,
): Promise<void> => {
  const normalizedModelSize = normalizeLocalWhisperModel(modelSize);
  produceAppState((draft) => {
    draft.settings.aiTranscription.modelSize = normalizedModelSize;
  });

  await updateUserPreferences((preferences) => {
    preferences.transcriptionModelSize = normalizedModelSize;
  });
};

export const setGpuEnumerationEnabled = async (
  enabled: boolean,
): Promise<void> => {
  const nextEnabled = supportsGpuTranscriptionDevice() && enabled;
  produceAppState((draft) => {
    draft.settings.aiTranscription.gpuEnumerationEnabled = nextEnabled;
  });

  await updateUserPreferences((preferences) => {
    preferences.gpuEnumerationEnabled = nextEnabled;
  });
};

export const setPreferredPostProcessingMode = async (
  mode: PostProcessingMode,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.postProcessingMode = mode;
  });
};

export const setPreferredPostProcessingApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.aiPostProcessing.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.postProcessingApiKeyId = id;
  });
};

export const setPreferredAgentMode = async (mode: AgentMode): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.agentMode.mode = mode;
  });

  await updateUserPreferences((preferences) => {
    preferences.agentMode = mode;
  });
};

export const setPreferredAgentModeApiKeyId = async (
  id: Nullable<string>,
): Promise<void> => {
  produceAppState((draft) => {
    draft.settings.agentMode.selectedApiKeyId = id;
  });

  await updateUserPreferences((preferences) => {
    preferences.agentModeApiKeyId = id;
  });
};

export const migrateLocalUserToCloud = async (): Promise<void> => {
  const state = getAppState();
  const userId = state.auth?.uid;
  if (!userId) {
    return;
  }

  const localUser = state.userById[LOCAL_USER_ID];
  if (!localUser) {
    return;
  }

  if (state.userById[userId]) {
    return;
  }

  const repo = new CloudUserRepo();
  const now = new Date().toISOString();
  const payload: User = {
    ...localUser,
    id: userId,
    createdAt: localUser.createdAt ?? now,
    updatedAt: now,
    shouldShowUpgradeDialog: false,
  };

  try {
    const saved = await repo.setMyUser(payload);
    produceAppState((draft) => {
      setCurrentUser(draft, saved);
    });
  } catch (error) {
    console.error("Failed migrating local user to cloud", error);
    throw error;
  }
};

export const setGotStartedAtNow = async (): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.gotStartedAt = Date.now();
  }, "Failed to save got started timestamp. Please try again.");
};

export const clearGotStartedAt = async (): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.gotStartedAt = null;
  }, "Failed to clear got started timestamp. Please try again.");
};

export const markFeatureSeen = (featureDate: string): void => {
  produceAppState((draft) => {
    draft.local.featureSeenAt = featureDate;
  });
};

export const setIgnoreUpdateDialog = async (ignore: boolean): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.ignoreUpdateDialog = ignore;
  }, "Failed to save update dialog preference. Please try again.");
};

export const setIncognitoModeEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.incognitoModeEnabled = enabled;
    if (!enabled) {
      // Reset to default when disabling for clarity.
      preferences.incognitoModeIncludeInStats = false;
    }
  }, "Failed to save incognito mode preference. Please try again.");
};

export const setIncognitoModeIncludeInStats = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.incognitoModeIncludeInStats = enabled;
  }, "Failed to save incognito mode stats preference. Please try again.");
};

export const setDictationPillVisibility = async (
  visibility: DictationPillVisibility,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationPillVisibility = visibility;
  }, "Failed to save dictation pill visibility preference. Please try again.");
};

export const setDictationLimitMinutes = async (
  minutes: number,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationLimitMinutes = normalizeDictationLimitMinutes(minutes);
  }, "Failed to save dictation limit preference. Please try again.");
};

export const setRealtimeOutputEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.realtimeOutputEnabled = enabled;
  }, "Failed to save real-time output preference. Please try again.");
};

export const setRemoteOutputEnabled = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteOutputEnabled = enabled;
  }, "Failed to save multi-device sender preference. Please try again.");
};

export const setRemoteTargetDeviceId = async (
  deviceId: Nullable<string>,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteTargetDeviceId = deviceId;
    preferences.remoteOutputEnabled = Boolean(deviceId);
  }, "Failed to save paired receiver selection. Please try again.");
};

export const setRemoteReceiverPort = async (
  port: Nullable<number>,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteReceiverPort = port;
  }, "Failed to save remote receiver port. Please try again.");
};

export const setRemoteReceiverAutoStart = async (
  enabled: boolean,
): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.remoteReceiverAutoStart = enabled;
  }, "Failed to save receiver auto-start preference. Please try again.");
};

export const setMenuBarIconHidden = async (hidden: boolean): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.menuBarIconHidden = hidden;
  }, "Failed to save menu bar icon preference. Please try again.");
};

export const setDictationAudioDim = async (value: number): Promise<void> => {
  await updateUserPreferences((preferences) => {
    preferences.dictationAudioDim = Math.max(0, Math.min(1, value));
  }, "Failed to save audio dim preference. Please try again.");
};

export const setStylingMode = async (
  mode: Nullable<StylingMode>,
): Promise<void> => {
  await updateUser(
    (user) => {
      user.stylingMode = mode;
    },
    "Unable to set styling mode. User not found.",
    "Failed to save styling mode preference. Please try again.",
  );
};

export const setActiveToneIds = async (toneIds: string[]): Promise<void> => {
  await updateUser(
    (user) => {
      user.activeToneIds = toneIds;
    },
    "Unable to update active styles. User not found.",
    "Failed to update active styles. Please try again.",
  );
};

export const setSelectedToneId = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      user.selectedToneId = toneId;
    },
    "Unable to select style. User not found.",
    "Failed to select style. Please try again.",
  );
  setLocalStorageValue("voquill:checklist-writing-style", true);
};

export const activateAndSelectTone = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      const currentIds = user.activeToneIds ?? [];
      if (!currentIds.includes(toneId)) {
        user.activeToneIds = [toneId, ...currentIds];
      }
      user.selectedToneId = toneId;
    },
    "Unable to activate style. User not found.",
    "Failed to activate style. Please try again.",
  );
};

export const deselectActiveTone = async (toneId: string): Promise<void> => {
  await updateUser(
    (user) => {
      const current = user.activeToneIds ?? [];
      user.activeToneIds = current.filter((id) => id !== toneId);
    },
    "Unable to deselect style. User not found.",
    "Failed to deselect style. Please try again.",
  );
};

export const markUpgradeDialogSeen = async (): Promise<void> => {
  await updateUser(
    (user) => {
      user.shouldShowUpgradeDialog = false;
    },
    "Unable to mark upgrade dialog as seen. User not found.",
    "Failed to mark upgrade dialog as seen. Please try again.",
  );
};
