import { invoke } from "@tauri-apps/api/core";
import { delayed } from "@voquill/utilities";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useIntl } from "react-intl";
import {
  loadManualStyleForCurrentApp,
  saveManualStyleForApp,
  tryRegisterCurrentAppTarget,
} from "../../actions/app-target.actions";
import {
  createConversation,
  loadChatMessages,
  sendChatMessage,
} from "../../actions/chat.actions";
import { refreshMember } from "../../actions/member.actions";
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
  resolveDesktopDictationContext,
  storeTranscription,
} from "../../actions/transcribe.actions";
import { recordStreak } from "../../actions/user.actions";
import {
  useHotkeyFire,
  useHotkeyHold,
  useHotkeyHoldMany,
} from "../../hooks/hotkey.hooks";
import { useTauriListen } from "../../hooks/tauri.hooks";
import { useToastAction } from "../../hooks/toast.hooks";
import { browserRouter } from "../../router";
import { createTranscriptionSession } from "../../sessions";
import { RecordingMode } from "../../state/app.state";
import { getAppState, produceAppState, useAppStore } from "../../store";
import { AgentStrategy } from "../../strategies/agent.strategy";
import { BaseStrategy } from "../../strategies/base.strategy";
import { DictationStrategy } from "../../strategies/dictation.strategy";
import {
  ScreenContextInfo,
  TextFieldInfo,
} from "../../types/accessibility.types";
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
import {
  cleanupAudioFile,
  playAlertSound,
  tryPlayAudioChime,
} from "../../utils/audio.utils";
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
  OPEN_CHAT_HOTKEY,
  SWITCH_WRITING_STYLE_BACKWARD_HOTKEY,
  SWITCH_WRITING_STYLE_FORWARD_HOTKEY,
  syncHotkeyCombosToNative,
} from "../../utils/keyboard.utils";
import { getLogger } from "../../utils/log.utils";
import { mergeScreenContexts } from "../../utils/prompt.utils";
import { getScreenCaptureContext } from "../../utils/screen-context-provider";
import {
  getActiveManualToneIds,
  getManuallySelectedToneId,
  getToneById,
  getToneIdToUse,
} from "../../utils/tone.utils";
import {
  getEffectivePillVisibility,
  getIsDictationUnlocked,
  getIsOnboarded,
  getMyPreferredMicrophone,
  getMyPrimaryDictationLanguage,
  getMyUserPreferences,
  getTranscriptionPrefs,
} from "../../utils/user.utils";
import { surfaceMainWindow } from "../../utils/window.utils";

type StartRecordingResponse = {
  sampleRate: number;
};

type AbortMessage = {
  title?: string;
  body: unknown;
};

type RawStopResp = {
  shouldContinue: boolean;
  abortMessage?: string;
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
  const earlyOcrRef = useRef<{
    ocrText: string | null;
    startedAt: number;
  } | null>(null);
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
  const pillVisibility = useAppStore((state) =>
    getEffectivePillVisibility(state.userPrefs?.dictationPillVisibility),
  );

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
    if (dimLevel >= 1.0) return;

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
      restoreSystemVolume,
      intl,
    ],
  );

  const stopRecordingRaw = useCallback(async (): Promise<RawStopResp> => {
    getLogger().info("Stopping recording");
    clearRecordingTimers();
    restoreSystemVolume();

    const t0 = performance.now();

    // Start audio recording stop and context collection in parallel
    const audioPromise = (async () => {
      try {
        tryPlayAudioChime("stop_recording_clip");
        await strategyRef.current?.setPhase("loading");
        const audio = await invoke<StopRecordingResponse>("stop_recording");
        getLogger().verbose(
          `Recording stopped (filePath=${audio?.filePath ? "yes" : "none"})`,
        );
        return audio;
      } catch (error) {
        getLogger().error(`Failed to stop recording: ${error}`);
        showToast({
          message: intl.formatMessage({
            defaultMessage: "Failed to stop recording",
          }),
          toastType: "error",
          duration: 8_000,
        });
        return null;
      }
    })();

    // Context collection in parallel — use cached OCR if available (Fix 3)
    const contextPromise = (async () => {
      getLogger().verbose("Fetching finalize-time context (parallel)");

      const OCR_STALE_MS = 30_000;
      const cachedOcr = earlyOcrRef.current;
      const ocrIsFresh =
        cachedOcr != null && Date.now() - cachedOcr.startedAt < OCR_STALE_MS;

      const screenCapturePromise = ocrIsFresh
        ? Promise.resolve(cachedOcr.ocrText)
        : getScreenCaptureContext();

      if (ocrIsFresh) {
        getLogger().verbose(
          `[perf] using cached OCR (age=${Date.now() - cachedOcr.startedAt}ms)`,
        );
      }

      const [
        a11yInfo,
        accessibilityScreenContext,
        screenCaptureContext,
        clipboardText,
        appTarget,
      ] = await Promise.all([
        invoke<TextFieldInfo>("get_text_field_info").catch((error) => {
          getLogger().verbose(`Failed to get text field info: ${error}`);
          return null;
        }),
        invoke<ScreenContextInfo>("get_screen_context")
          .then((result) => result.screenContext)
          .catch((error) => {
            getLogger().verbose(`Failed to get screen context: ${error}`);
            return null;
          }),
        screenCapturePromise,
        Promise.race([
          navigator.clipboard.readText().catch(() => null),
          new Promise<null>((resolve) => setTimeout(() => resolve(null), 500)),
        ]).catch((error) => {
          getLogger().verbose(`Failed to read clipboard: ${error}`);
          return null;
        }),
        tryRegisterCurrentAppTarget().catch((error) => {
          getLogger().verbose(`Failed to get current app target: ${error}`);
          return null;
        }),
      ]);

      earlyOcrRef.current = null;

      getLogger().verbose(
        `[context] screenCaptureContext=${screenCaptureContext ? `${screenCaptureContext.length} chars` : "null"}`,
      );
      getLogger().verbose(
        `[context] accessibilityScreenContext=${accessibilityScreenContext ? `${accessibilityScreenContext.length} chars` : "null"}`,
      );

      const screenContext = mergeScreenContexts({
        accessibilityContext: accessibilityScreenContext,
        screenCaptureContext,
      });

      getLogger().verbose(
        `[context] screenContext (merged)=${screenContext ? `${screenContext.length} chars` : "null"}`,
      );
      getLogger().verbose(`[context] appTarget=${appTarget?.name ?? "null"}`);

      const t1 = performance.now();
      getLogger().info(`[perf] context: ${(t1 - t0).toFixed(0)}ms`);

      return { a11yInfo, screenContext, clipboardText, appTarget };
    })();

    // Wait for audio first (fast path)
    const audio = await audioPromise;
    if (!audio) {
      getLogger().warning("stopRecordingRaw: no audio data received");
      return {
        shouldContinue: false,
        abortMessage: "No audio data received",
      };
    }

    // Ensure temp file cleanup on all exit paths (success, error, early return)
    try {
    const t1 = performance.now();
    getLogger().info(`[perf] audio-stop: ${(t1 - t0).toFixed(0)}ms`);

    // Start transcription immediately with audio only
    getLogger().info(
      "Finalizing transcription session (STT starting immediately)",
    );

    const transcribeResult = await sessionRef.current?.finalize(audio, {
      toneId: null,
      a11yInfo: null,
      currentApp: null,
      currentEditor: null,
      selectedText: null,
      screenContext: null,
    });
    const rawTranscript = transcribeResult?.rawTranscript;

    const t2 = performance.now();
    getLogger().info(`[perf] stt: ${(t2 - t1).toFixed(0)}ms`);
    getLogger().verbose(
      `Transcription result: rawTranscript=${rawTranscript ? `${rawTranscript.length} chars` : "empty"}`,
    );

    if (!rawTranscript) {
      getLogger().warning("stopRecordingRaw: no rawTranscript from finalize");
      return {
        shouldContinue: false,
      };
    }

    const session = sessionRef.current;
    const strategy = strategyRef.current;
    if (!session || !strategy) {
      getLogger().warning(
        `stopRecordingRaw: refs cleared (session=${!!session}, strategy=${!!strategy})`,
      );
      return {
        shouldContinue: false,
      };
    }

    // Now wait for context (if not already ready)
    getLogger().verbose("Waiting for context to apply to transcript");
    const { a11yInfo, screenContext, clipboardText, appTarget } =
      await contextPromise;

    trackAppUsed(appTarget?.name ?? "Unknown");

    if (appTarget) {
      saveManualStyleForApp(appTarget);
    }

    const toneId = getToneIdToUse(getAppState(), {
      currentAppToneId: appTarget?.toneId ?? null,
    });
    const desktopContext = resolveDesktopDictationContext({
      currentApp: appTarget
        ? {
            id: appTarget.id,
            name: appTarget.name,
          }
        : null,
      a11yInfo,
      screenContext,
    });
    getLogger().verbose(
      `[context] desktopContext.screenContext=${desktopContext.screenContext ? `${desktopContext.screenContext.length} chars` : "null"}`,
    );
    getLogger().verbose(
      `[context] desktopContext.currentApp=${desktopContext.currentApp?.name ?? "null"}`,
    );

    if (getAppState().activeRecordingMode === "agent") {
      await strategy.setPhase("idle");
    }

    getLogger().info("Post-processing transcript with context");
    const result = await strategy.handleTranscript({
      rawTranscript,
      processedTranscript: transcribeResult.processedTranscript,
      serverPostProcessMetadata: transcribeResult.postProcessMetadata,
      toneId,
      a11yInfo,
      currentApp: appTarget,
      currentEditor: desktopContext.currentEditor,
      selectedText: desktopContext.selectedText,
      screenContext: desktopContext.screenContext,
      clipboardContext: clipboardText,
      loadingToken: null,
      audio,
      transcriptionMetadata: transcribeResult.metadata,
      transcriptionWarnings: transcribeResult.warnings,
    });

    const t3 = performance.now();
    getLogger().info(`[perf] post-process: ${(t3 - t2).toFixed(0)}ms`);

    const transcript = result.transcript;
    const sanitizedTranscript = result.sanitizedTranscript;
    const postProcessMetadata = result.postProcessMetadata;
    const postProcessWarnings = result.postProcessWarnings;
    getLogger().verbose(
      `Post-processing complete: transcript=${transcript ? `${transcript.length} chars` : "empty"}, warnings=${postProcessWarnings.length}`,
    );

    if (strategy.shouldStoreTranscript()) {
      getLogger().verbose("Storing transcription");
      storeTranscription({
        audio,
        rawTranscript: rawTranscript ?? null,
        sanitizedTranscript,
        transcript,
        authoritativeTranscript:
          transcribeResult.authoritativeTranscript ?? rawTranscript ?? null,
        isAuthoritative: transcribeResult.isAuthoritative ?? undefined,
        isFinalized: transcribeResult.isFinalized ?? undefined,
        dictationIntent: transcribeResult.dictationIntent ?? undefined,
        transcriptionMetadata: transcribeResult.metadata,
        postProcessMetadata,
        warnings: [...transcribeResult.warnings, ...postProcessWarnings],
        remoteStatus: result.remoteStatus,
        remoteDeviceId: result.remoteDeviceId,
      });
    }

    const t4 = performance.now();
    getLogger().info(`[perf] paste: ${(t4 - t3).toFixed(0)}ms`);
    getLogger().info(`[perf] total: ${(t4 - t0).toFixed(0)}ms`);

    refreshMember();
    return {
      shouldContinue: result.shouldContinue,
    };
    } finally {
      // Clean up temp recording file on all paths (success + error)
      if (audio.filePath) cleanupAudioFile(audio.filePath);
    }
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
    isStoppingRef.current = true;
    setIsStopping(true);
    try {
      const res = await stopRecordingRaw().catch((error) => {
        getLogger().error(
          `Error during stopRecording: ${error}${error instanceof Error ? ` [name=${error.name}, stack=${error.stack}]` : ""}`,
        );
        return {
          shouldContinue: false,
          abortMessage: String(error),
        };
      });

      getLogger().info(
        `stopRecording result: shouldContinue=${res.shouldContinue}, abortMessage=${res.abortMessage ?? "none"}`,
      );
      if (!res.shouldContinue) {
        await abortRecording(
          res.abortMessage ? { body: res.abortMessage } : undefined,
        );
      }
    } finally {
      hardResetHotkeyState();
      isStoppingRef.current = false;
      setIsStopping(false);
    }
  }, [abortRecording, hardResetHotkeyState, stopRecordingRaw, setIsStopping]);

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
        getLogger().info(
          `Created transcription session: ${session.constructor.name}`,
        );

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
        await sessionRef.current.onRecordingStart(sampleRate);
        if (!sessionRef.current || !strategyRef.current) {
          abortRecording();
          return;
        }

        // Pre-collect OCR context while recording (Fix 3: saves 670-3700ms at stop time)
        earlyOcrRef.current = null;
        getScreenCaptureContext()
          .then((ocrText) => {
            earlyOcrRef.current = { ocrText, startedAt: Date.now() };
            getLogger().verbose(
              `[perf] early OCR collected: ${ocrText ? `${ocrText.length} chars` : "null"}`,
            );
          })
          .catch(() => {});

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

  const openPillConversation = useCallback(
    async (conversationId?: string) => {
      const id = conversationId ?? getAppState().pillConversationId;
      if (id) {
        void loadChatMessages(id);
        browserRouter.navigate(`/dashboard/chats?id=${encodeURIComponent(id)}`);
      }
      await surfaceMainWindow();
      await abortRecording();
    },
    [abortRecording],
  );

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

      let conversationId = getAppState().pillConversationId;
      if (!conversationId) {
        const now = new Date().toISOString();
        const conversation = await createConversation({
          id: createId(),
          title: intl.formatMessage({
            defaultMessage: "New conversation",
          }),
          createdAt: now,
          updatedAt: now,
        });
        conversationId = conversation.id;
        produceAppState((draft) => {
          draft.pillConversationId = conversation.id;
        });
      }

      getLogger().info(`Sending typed message (${text.length} chars)`);
      sendChatMessage(conversationId, text).catch((error) => {
        getLogger().error(`Failed to send typed message: ${error}`);
      });
    },
  );

  useTauriListen<{ conversationId: string }>(
    "open-pill-conversation",
    (payload) => openPillConversation(payload.conversationId),
  );

  useHotkeyFire({
    actionName: OPEN_CHAT_HOTKEY,
    isDisabled: !isActiveSession,
    onFire: openPillConversation,
  });

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
