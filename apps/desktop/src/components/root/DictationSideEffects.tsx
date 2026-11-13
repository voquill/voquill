import { invoke } from "@tauri-apps/api/core";
import { AppTarget } from "@voquill/types";
import { delayed } from "@voquill/utilities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  loadManualStyleForCurrentApp,
  saveManualStyleForApp,
  tryRegisterCurrentAppTarget,
} from "../../actions/app-target.actions";
import { sendChatMessage } from "../../actions/chat.actions";
import { dismissToast, showToast } from "../../actions/toast.actions";
import {
  switchWritingStyleBackward,
  switchWritingStyleForward,
} from "../../actions/tone.actions";
import {
  resolveToolPermission,
  setToolAlwaysAllow,
} from "../../actions/tool.actions";
import {
  finishDictation,
  type FinishDictationOutcome,
} from "../../actions/dictation.actions";
import { recordStreak } from "../../actions/user.actions";
import {
  useHotkeyFire,
  useHotkeyHold,
  useHotkeyHoldMany,
} from "../../hooks/hotkey.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { createTranscriptionSession } from "../../sessions";
import { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AgentStrategy } from "../../strategies/agent.strategy";
import { BaseStrategy } from "../../strategies/base.strategy";
import { DictationStrategy } from "../../strategies/dictation.strategy";
import { TextFieldInfo } from "../../types/accessibility.types";
import type { OverlayResolvePermissionPayload } from "../../types/overlay.types";
import {
  StopRecordingResponse,
  TranscriptionSession,
} from "../../types/transcription-session.types";
import {
  ActivationController,
  debouncedToggle,
} from "../../utils/activation.utils";
import {
  trackAgentStart,
  trackAppUsed,
  trackDictationStart,
} from "../../utils/analytics.utils";
import { getIsAssistantModeEnabled } from "../../utils/assistant-mode.utils";
import { playAlertSound, tryPlayAudioChime } from "../../utils/audio.utils";
import { getIsMeetingCapturing } from "../../utils/note.utils";
import {
  DEFAULT_DICTATION_LIMIT_MINUTES,
  getDictationRecordingTimerDurations,
  getEffectiveDictationLimitMinutes,
  shouldEnableDictationLimit,
} from "../../utils/dictation-limit.utils";
import { getEffectiveStylingMode } from "../../utils/feature.utils";
import { createId } from "../../utils/id.utils";
import {
  AGENT_DICTATE_HOTKEY,
  CANCEL_TRANSCRIPTION_HOTKEY,
  DICTATE_HOTKEY,
  getAdditionalLanguageEntries,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { getLogger } from "../../utils/log.utils";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
  getToneIdToUse,
} from "../../utils/tone.utils";
import {
  getIsDictationUnlocked,
  getIsOnboarded,
  getMyPreferredMicrophone,
  getMyPrimaryDictationLanguage,
  getMyUserPreferences,
  getPillVisibilityToApply,
  getTranscriptionPrefs,
} from "../../utils/user.utils";

type StartRecordingResponse = {
  sampleRate: number;
};

type AbortMessage = {
  title?: string;
  body: unknown;
};

export const DictationSideEffects = () => {
  const intl = useIntl();

  const strategyRef = useRef<BaseStrategy | null>(null);
  const sessionRef = useRef<TranscriptionSession | null>(null);
  const preDictationVolumeRef = useRef<number | null>(null);
  const recordingWarningTimerRef = useRef<NodeJS.Timeout | null>(null);
  const recordingAutoStopTimerRef = useRef<NodeJS.Timeout | null>(null);
  const cancelPromptTimerRef = useRef<NodeJS.Timeout | null>(null);
  const isStoppingRef = useRef(false);
  const stopIdRef = useRef(0);
  const [isStopping, setIsStopping] = useState(false);
  const assistantModeEnabled = useAppStore(getIsAssistantModeEnabled);

  const isManualStyling = useAppStore(
    (state) => getEffectiveStylingMode(state) === "manual",
  );
  const isActiveSession = useAppStore(
    (state) => state.activeRecordingMode !== null,
  );
  const activeRecordingMode = useAppStore((state) => state.activeRecordingMode);
  const assistantInputMode = useAppStore((state) => state.assistantInputMode);
  const additionalLanguageEntries = useAppStore(getAdditionalLanguageEntries);
  const isDictationUnlocked = useAppStore(getIsDictationUnlocked);
  const isDictationInteractable = isDictationUnlocked && !isStopping;
  const pillVisibility = useAppStore(getPillVisibilityToApply);

  const dictationController = useMemo(
    () =>
      new ActivationController(
        () => startDictationRecording(),
        () => stopDictationRecording(),
      ),
    [],
  );

  const agentController = useMemo(
    () =>
      new ActivationController(
        () => startAgentRecording(),
        () => stopAgentRecording(),
      ),
    [],
  );

  const additionalLanguageControllers = useMemo(
    () =>
      additionalLanguageEntries.map((entry) => ({
        actionName: entry.actionName,
        controller: new ActivationController(
          () =>
            startRecording({
              mode: "dictate",
              language: entry.language,
            }),
          () => stopRecording(),
        ),
      })),
    [additionalLanguageEntries],
  );

  const restoreSystemVolume = useCallback(() => {
    const savedVolume = preDictationVolumeRef.current;
    preDictationVolumeRef.current = null;
    if (savedVolume !== null) {
      invoke("set_system_volume", { volume: savedVolume }).catch((e) =>
        getLogger().verbose(`Failed to restore system volume: ${e}`),
      );
    }
  }, []);

  const dimSystemVolume = useCallback(async () => {
    const dimLevel = getAppState().userPrefs?.dictationAudioDim ?? 1.0;
    if (dimLevel >= 1.0 || getIsMeetingCapturing(getAppState())) return;

    try {
      const currentVolume = await invoke<number>("get_system_volume");
      preDictationVolumeRef.current = currentVolume;
      const dimmedVolume = currentVolume * dimLevel;
      await invoke("set_system_volume", { volume: dimmedVolume });
    } catch (e) {
      getLogger().verbose(`Failed to dim system volume: ${e}`);
    }
  }, []);

  const clearRecordingTimers = useCallback(() => {
    if (recordingWarningTimerRef.current) {
      clearTimeout(recordingWarningTimerRef.current);
      recordingWarningTimerRef.current = null;
    }
    if (recordingAutoStopTimerRef.current) {
      clearTimeout(recordingAutoStopTimerRef.current);
      recordingAutoStopTimerRef.current = null;
    }
  }, []);

  const clearCancelPromptTimer = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearTimeout(cancelPromptTimerRef.current);
      cancelPromptTimerRef.current = null;
    }
  }, []);

  const clearRecordingState = useCallback(() => {
    produceAppState((draft) => {
      draft.activeRecordingMode = null;
      draft.dictationLanguageOverride = null;
      draft.assistantInputMode = "voice";
    });
  }, []);

  const hardResetHotkeyState = useCallback(() => {
    dictationController.forceReset();
    agentController.forceReset();
    for (const { controller } of additionalLanguageControllers) {
      controller.forceReset();
    }

    produceAppState((draft) => {
      draft.keysHeld = [];
    });

    invoke("reset_key_listener_state").catch((error) =>
      getLogger().verbose(`Failed to reset key listener state: ${error}`),
    );
  }, [additionalLanguageControllers, agentController, dictationController]);

  const releaseStopping = useCallback(() => {
    hardResetHotkeyState();
    isStoppingRef.current = false;
    setIsStopping(false);
  }, [hardResetHotkeyState]);

  const abortRecording = useCallback(
    async (message?: AbortMessage) => {
      getLogger().info(
        `Aborting recording (hasSession=${!!sessionRef.current}, hasStrategy=${!!strategyRef.current}${message ? `, reason=${String(message.body).slice(0, 120)}` : ""})`,
      );
      clearRecordingTimers();
      clearCancelPromptTimer();
      hardResetHotkeyState();
      restoreSystemVolume();
      invoke<void>("set_phase", { phase: "idle" });
      invoke("stop_recording").catch((e) =>
        getLogger().verbose(`stop_recording failed during abort: ${e}`),
      );

      sessionRef.current?.cleanup();
      strategyRef.current?.cleanup();
      strategyRef.current = null;
      sessionRef.current = null;

      clearRecordingState();
      if (isStoppingRef.current) {
        // Cancelling during transcription frees the hotkeys right away; the
        // in-flight stop sees it was superseded and does nothing further.
        stopIdRef.current++;
        releaseStopping();
      }

      if (message) {
        playAlertSound();
        showToast({
          message: String(message.body),
          toastType: "error",
          duration: 8_000,
        });
      }
    },
    [
      clearCancelPromptTimer,
      clearRecordingState,
      clearRecordingTimers,
      hardResetHotkeyState,
      releaseStopping,
      restoreSystemVolume,
      intl,
    ],
  );

  const stopRecordingRaw =
    useCallback(async (): Promise<FinishDictationOutcome> => {
      getLogger().info("Stopping recording");
      clearRecordingTimers();
      restoreSystemVolume();

      const [audio, a11yInfo, appTarget] = await getLogger().stopwatch(
        "stopRecording",
        async () => {
          let audio: StopRecordingResponse | null = null;
          let a11yInfo: TextFieldInfo | null = null;
          let appTarget: AppTarget | null = null;
          try {
            tryPlayAudioChime("stop_recording_clip");

            getLogger().verbose(
              "Invoking stop_recording and fetching a11y info",
            );
            const [, outAudio, outA11yInfo, outAppTarget] = await Promise.all([
              strategyRef.current?.setPhase("loading"),
              invoke<StopRecordingResponse>("stop_recording"),
              invoke<TextFieldInfo>("get_text_field_info").catch((error) => {
                getLogger().verbose(`Failed to get text field info: ${error}`);
                return null;
              }),
              tryRegisterCurrentAppTarget().catch((error) => {
                getLogger().verbose(
                  `Failed to get current app target: ${error}`,
                );
                return null;
              }),
            ]);

            audio = outAudio;
            a11yInfo = outA11yInfo;
            appTarget = outAppTarget;
            getLogger().verbose(
              `Recording stopped (hasSamples=${!!audio?.samples})`,
            );
          } catch (error) {
            getLogger().error(`Failed to stop recording: ${error}`);
            showToast({
              message: intl.formatMessage({
                defaultMessage: "Failed to stop recording",
              }),
              toastType: "error",
              duration: 8_000,
            });
          }

          return [audio, a11yInfo, appTarget];
        },
      );

      if (!audio) {
        getLogger().warning("stopRecordingRaw: no audio data received");
        return {
          shouldContinue: false,
          abortMessage: "No audio data received",
        };
      }

      getLogger().info("Finalizing transcription session");
      trackAppUsed(appTarget?.name ?? "Unknown");

      if (appTarget) {
        saveManualStyleForApp(appTarget);
      }

      const toneId = getToneIdToUse(getAppState(), {
        currentAppToneId: appTarget?.toneId ?? null,
      });

      const session = sessionRef.current;
      const strategy = strategyRef.current;
      if (!session || !strategy) {
        getLogger().warning(
          `stopRecordingRaw: refs cleared (session=${!!session}, strategy=${!!strategy})`,
        );
        return { shouldContinue: false };
      }

      return await finishDictation({
        session,
        strategy,
        audio,
        toneId,
        a11yInfo,
        appTarget,
        isCurrent: () =>
          sessionRef.current === session && strategyRef.current === strategy,
      });
    }, [restoreSystemVolume]);

  const stopRecording = useCallback(async () => {
    if (isStoppingRef.current) {
      getLogger().info("stopRecording skipped (already stopping)");
      return;
    }

    const hasOnboarded = getIsOnboarded(getAppState());
    if (hasOnboarded) {
      delayed(2000).then(() => recordStreak());
    }

    getLogger().info("stopRecording entered");
    const stopId = ++stopIdRef.current;
    isStoppingRef.current = true;
    setIsStopping(true);
    try {
      const res: FinishDictationOutcome = await stopRecordingRaw().catch(
        (error) => {
          getLogger().error(
            `Error during stopRecording: ${error}${error instanceof Error ? ` [name=${error.name}, stack=${error.stack}]` : ""}`,
          );
          return {
            shouldContinue: false,
            abortMessage: String(error),
          };
        },
      );

      getLogger().info(
        `stopRecording result: shouldContinue=${res.shouldContinue}, superseded=${!!res.superseded}, abortMessage=${res.abortMessage ?? "none"}`,
      );
      if (!res.shouldContinue && !res.superseded) {
        await abortRecording(
          res.abortMessage ? { body: res.abortMessage } : undefined,
        );
      }
    } finally {
      if (stopIdRef.current === stopId) {
        releaseStopping();
      }
    }
  }, [abortRecording, releaseStopping, stopRecordingRaw]);

  const startRecordingTimers = useCallback(() => {
    clearRecordingTimers();

    const state = getAppState();
    const preferences = getMyUserPreferences(state);
    const transcriptionPrefs = getTranscriptionPrefs(state);

    const dictationLimitMinutes = shouldEnableDictationLimit(
      transcriptionPrefs.mode,
    )
      ? getEffectiveDictationLimitMinutes(preferences)
      : DEFAULT_DICTATION_LIMIT_MINUTES;
    const { warningDurationMs, autoStopDurationMs } =
      getDictationRecordingTimerDurations(dictationLimitMinutes);

    if (warningDurationMs !== null) {
      recordingWarningTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Recording duration warning (${dictationLimitMinutes} min limit)`,
        );
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording will stop in 60 seconds",
          }),
          toastType: "info",
          duration: 5_000,
        });
      }, warningDurationMs);
    }

    if (autoStopDurationMs !== null) {
      recordingAutoStopTimerRef.current = setTimeout(() => {
        getLogger().warning(
          `Recording auto-stopped (${dictationLimitMinutes} min limit)`,
        );
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording stopped: duration limit reached",
          }),
          toastType: "info",
          duration: 5_000,
        });

        stopRecording();
      }, autoStopDurationMs);
    }
  }, [stopRecording, intl, clearRecordingTimers]);

  const startRecording = useCallback(
    async (args: { mode: RecordingMode; language?: string | null }) => {
      const state = getAppState();
      const mode = args.mode;
      const language = args.language || getMyPrimaryDictationLanguage(state);
      produceAppState((draft) => {
        draft.activeRecordingMode = mode;
        draft.dictationLanguageOverride = language;
      });

      let strategy: BaseStrategy | null = strategyRef.current ?? null;
      if (!strategy) {
        if (mode === "agent") {
          strategy = new AgentStrategy();
        } else {
          strategy = new DictationStrategy();
        }
      }

      const validationError = strategy.validateAvailability();
      if (validationError) {
        abortRecording({
          title: validationError.title,
          body: validationError.body,
        });
        return;
      }

      if (
        mode === "dictate" &&
        !state.onboarding.dictationOverrideEnabled &&
        !state.local.disableAutoStyleLoading
      ) {
        loadManualStyleForCurrentApp();
      }

      const preferredMicrophone = getMyPreferredMicrophone(state);
      const transcriptPrefs = getTranscriptionPrefs(state);
      try {
        getLogger().info(`Transcription prefs: mode=${transcriptPrefs.mode}`);
        const session = createTranscriptionSession(transcriptPrefs);
        getLogger().info(`Created transcription session: ${session.name}`);

        tryPlayAudioChime("start_recording_clip");
        if (session.supportsStreaming()) {
          session.setInterimResultCallback((segment) => {
            strategy.handleInterimSegment(segment);
          });
        }

        sessionRef.current = session;
        strategyRef.current = strategy;
        await strategy.onBeforeStart();

        getLogger().info(
          `Starting recording (mic=${preferredMicrophone ?? "default"})`,
        );
        const [, startRecordingResult] = await Promise.all([
          strategy.setPhase("recording"),
          invoke<StartRecordingResponse>("start_recording", {
            args: { preferredMicrophone },
          }),
        ]);

        const sampleRate = startRecordingResult.sampleRate;
        getLogger().verbose(`Recording started (sampleRate=${sampleRate})`);
        await session.onRecordingStart(sampleRate);
        if (!sessionRef.current || !strategyRef.current) {
          abortRecording();
          return;
        }
        if (sessionRef.current !== session || isStoppingRef.current) {
          getLogger().info(
            "Recording already stopping or superseded; skipping start-up timers",
          );
          return;
        }

        startRecordingTimers();
        dimSystemVolume();
      } catch (error) {
        getLogger().error(`Failed to start recording: ${error}`);

        sessionRef.current?.cleanup();
        sessionRef.current = null;
        strategyRef.current = null;
        clearRecordingState();
        abortRecording();

        hardResetHotkeyState();
        clearRecordingTimers();
        invoke("stop_recording").catch((e) =>
          getLogger().verbose(
            `stop_recording failed during error handling: ${e}`,
          ),
        );

        showToast({
          message: intl.formatMessage({
            defaultMessage: "Recording failed",
          }),
          toastType: "error",
          duration: 8_000,
        });
      }
    },
    [
      abortRecording,
      clearRecordingState,
      clearRecordingTimers,
      dimSystemVolume,
      hardResetHotkeyState,
      intl,
    ],
  );

  const startDictationRecording = useCallback(async () => {
    const state = getAppState();
    if (!getIsDictationUnlocked(state)) {
      getLogger().verbose("Dictation not unlocked, ignoring start");
      return;
    }

    getLogger().info("Starting dictation recording");
    trackDictationStart();
    produceAppState((draft) => {
      draft.local.lastDictatedAt = Date.now();
    });

    await startRecording({ mode: "dictate" });
  }, [startRecording]);

  const stopDictationRecording = useCallback(async () => {
    getLogger().info("Stopping dictation recording");
    await stopRecording();
  }, [stopRecording]);

  const startAgentRecording = useCallback(async () => {
    const state = getAppState();
    if (!getIsDictationUnlocked(state)) {
      getLogger().verbose("Dictation not unlocked, ignoring agent start");
      return;
    }

    if (state.assistantInputMode === "type") {
      getLogger().info("Switching from type mode back to voice mode");
      produceAppState((draft) => {
        draft.assistantInputMode = "voice";
      });
    }

    getLogger().info("Starting agent recording");
    trackAgentStart();
    await startRecording({ mode: "agent" });
  }, [startRecording]);

  const stopAgentRecording = useCallback(async () => {
    getLogger().info("Stopping agent recording");
    await stopRecording();
  }, [stopRecording]);

  const handleSwitchWritingStyleForward = useCallback(
    () => switchWritingStyleForward(),
    [],
  );

  const handleSwitchWritingStyleBackward = useCallback(
    () => switchWritingStyleBackward(),
    [],
  );

  const promptCancelTranscription = useCallback(() => {
    if (cancelPromptTimerRef.current) {
      clearCancelPromptTimer();
      dismissToast();
      abortRecording();
      return;
    }

    const CANCEL_PROMPT_DURATION = 5_000;
    cancelPromptTimerRef.current = setTimeout(() => {
      cancelPromptTimerRef.current = null;
    }, CANCEL_PROMPT_DURATION);

    void showToast({
      message: intl.formatMessage({
        defaultMessage: "Press cancel again to discard transcript",
      }),
      toastType: "info",
      action: "confirm_cancel_transcription",
      duration: CANCEL_PROMPT_DURATION,
    }).catch((error) => {
      getLogger().error(`Failed to show cancel transcription toast: ${error}`);
    });
  }, [intl]);

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling,
    onFire: handleSwitchWritingStyleForward,
  });

  useHotkeyFire({
    actionName: SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
    isDisabled: !isActiveSession || !isManualStyling,
    onFire: handleSwitchWritingStyleBackward,
  });

  useHotkeyHold({
    actionName: DICTATE_HOTKEY,
    isDisabled: !isDictationInteractable || activeRecordingMode === "agent",
    controller: dictationController,
  });

  useHotkeyHold({
    actionName: AGENT_DICTATE_HOTKEY,
    isDisabled:
      !isDictationInteractable ||
      !assistantModeEnabled ||
      activeRecordingMode === "dictate",
    controller: agentController,
  });

  useHotkeyFire({
    actionName: CANCEL_TRANSCRIPTION_HOTKEY,
    isDisabled: !isActiveSession,
    onFire: promptCancelTranscription,
  });

  useHotkeyHoldMany({
    isDisabled: !isDictationInteractable || activeRecordingMode === "agent",
    actions: additionalLanguageControllers,
  });

  useEffect(() => {
    syncHotkeyCombosToNative();
  }, [isActiveSession, isManualStyling]);

  useTauriListen<void>("assistant-mode-close", async () => {
    await abortRecording();
  });

  useTauriListen<void>("assistant-enable-type-mode", async () => {
    getLogger().info("Switching to type mode");

    // Stop the microphone/transcription without tearing down the assistant panel
    clearRecordingTimers();
    hardResetHotkeyState();
    invoke<void>("set_phase", { phase: "idle" }).catch(console.error);
    invoke("stop_recording").catch((e) =>
      getLogger().verbose(
        `stop_recording failed during type mode switch: ${e}`,
      ),
    );
    sessionRef.current?.cleanup();
    sessionRef.current = null;

    produceAppState((draft) => {
      draft.assistantInputMode = "type";
    });
  });

  useTauriListen<{ text: string }>(
    "assistant-typed-message",
    async (payload) => {
      const { text } = payload;
      if (!text.trim()) return;

      const conversationId = getAppState().pillConversationId ?? createId();
      produceAppState((draft) => {
        draft.pillConversationId = conversationId;
      });

      getLogger().info(`Sending typed message (${text.length} chars)`);
      sendChatMessage(conversationId, text).catch((error) => {
        getLogger().error(`Failed to send typed message: ${error}`);
      });
    },
  );

  useTauriListen<void>("cancel-dictation", () => {
    abortRecording();
  });

  useToastAction(async (payload) => {
    if (payload.action === "confirm_cancel_transcription") {
      await abortRecording();
    }
  });

  useTauriListen<void>("on-click-dictate", () => {
    if (isDictationInteractable) {
      debouncedToggle("dictation", dictationController);
    }
  });

  useTauriListen<void>("on-click-agent-talk", () => {
    if (isDictationInteractable) {
      debouncedToggle("agent", agentController);
    }
  });

  useTauriListen<void>("tone-switch-forward", () => {
    switchWritingStyleForward();
  });

  useTauriListen<void>("tone-switch-backward", () => {
    switchWritingStyleBackward();
  });

  useTauriListen<OverlayResolvePermissionPayload>(
    "overlay-resolve-permission",
    (payload) => {
      if (payload.alwaysAllow) {
        const permission =
          getAppState().toolPermissionById[payload.permissionId];
        if (permission) {
          setToolAlwaysAllow({
            toolId: permission.toolId,
            params: permission.params,
            allowed: true,
          });
        }
      }
      resolveToolPermission(payload.permissionId, payload.status);
    },
  );

  useEffect(() => {
    invoke("set_pill_visibility", { visibility: pillVisibility }).catch(
      console.error,
    );
  }, [pillVisibility]);

  const pillHasContent = useAppStore((state) => {
    if (!state.pillConversationId) return false;
    const ids =
      state.chatMessageIdsByConversationId[state.pillConversationId] ?? [];
    if (ids.length > 0) return true;
    return Object.values(state.toolPermissionById).some(
      (p) =>
        p.conversationId === state.pillConversationId && p.status === "pending",
    );
  });

  useEffect(() => {
    let size: string;
    if (activeRecordingMode !== "agent") {
      size = "dictation";
    } else if (assistantInputMode === "type") {
      size = "assistant_typing";
    } else if (pillHasContent) {
      size = "assistant_expanded";
    } else {
      size = "assistant_compact";
    }
    invoke("set_pill_window_size", { size }).catch(console.error);
  }, [activeRecordingMode, pillHasContent, assistantInputMode]);

  // Sync style info to native GTK4 pill
  const pillStyleCount = useAppStore((state) => {
    if (getEffectiveStylingMode(state) !== "manual") return 0;
    return getActiveManualToneIds(state).length;
  });
  const pillStyleName = useAppStore((state) => {
    const toneId = getManuallySelectedToneId(state);
    return getToneById(state, toneId)?.name ?? "-";
  });

  useEffect(() => {
    invoke("notify_pill_style_info", {
      count: pillStyleCount,
      name: pillStyleName,
    }).catch(console.error);
  }, [pillStyleCount, pillStyleName]);

  return null;
};
