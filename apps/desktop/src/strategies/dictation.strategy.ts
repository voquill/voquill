import { invoke } from "@tauri-apps/api/core";
import { createTranscriptReconciler } from "@voquill/dictation-core";
import type { Nullable } from "@voquill/types";
import { showErrorSnackbar, showSnackbar } from "../actions/app.actions";
import { tryRegisterCurrentAppTarget } from "../actions/app-target.actions";
import { showToast } from "../actions/toast.actions";
import {
  postProcessTranscript,
  type PostProcessMetadata,
} from "../actions/transcribe.actions";
import { getIntl } from "../i18n";
import { getAppState } from "../store";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyValidationError,
} from "../types/strategy.types";
import { getLogger } from "../utils/log.utils";
import { getMemberExceedsLimitByState } from "../utils/member.utils";
import { routeTranscriptOutput } from "../utils/output-routing.utils";
import {
  applyReplacements,
  applySymbolConversions,
} from "../utils/string.utils";
import { getToneIdToUse, VERBATIM_TONE_ID } from "../utils/tone.utils";
import {
  getEffectivePostProcessingMode,
  getEffectiveTranscriptionMode,
  getMyUserPreferences,
} from "../utils/user.utils";
import { BaseStrategy } from "./base.strategy";

export class DictationStrategy extends BaseStrategy {
  private streamedSegmentCount = 0;
  private streamedProcessedText = "";
  private streamedInsertedText = "";
  private streamedTranscriptReconciler = createTranscriptReconciler();
  private pasteQueue: Promise<void> = Promise.resolve();
  private currentAppId: string | null = null;
  private streamedOutputOutOfSync = false;

  shouldStoreTranscript(): boolean {
    return true;
  }

  get hasStreamedSegments(): boolean {
    return this.streamedSegmentCount > 0;
  }

  private getActiveRemoteTargetDeviceId(): string | null {
    const prefs = getMyUserPreferences(getAppState());
    if (!prefs?.remoteOutputEnabled || !prefs.remoteTargetDeviceId) {
      return null;
    }
    return prefs.remoteTargetDeviceId;
  }

  private async routeFinalTranscriptOutput(
    transcript: string,
    currentAppId: string | null,
  ): Promise<{
    remoteStatus: "sent" | null;
    remoteDeviceId: string | null;
  }> {
    const remoteDeviceId = this.getActiveRemoteTargetDeviceId();
    let remoteStatus: "sent" | null = null;

    await new Promise<void>((resolve) => setTimeout(resolve, 20));

    try {
      getLogger().verbose(
        `Routing transcript output (${transcript.length} chars, app=${currentAppId ?? "none"})`,
      );

      const textToPaste = transcript.trim() + " ";
      const result = await routeTranscriptOutput({
        text: textToPaste,
        mode: "dictation",
        currentAppId,
      });
      if (result.remote && result.delivered) {
        remoteStatus = "sent";
        showSnackbar("Transcript sent to paired receiver.", {
          mode: "success",
        });
      }

      getLogger().info("Transcript output routed successfully");
    } catch (error) {
      getLogger().error(`Failed to route transcription output: ${error}`);
      showErrorSnackbar("Unable to insert transcription.");
    }

    return {
      remoteStatus,
      remoteDeviceId: remoteStatus ? remoteDeviceId : null,
    };
  }

  private getStreamedTranscriptTail(transcript: string | null): string {
    const nextTranscript = transcript?.trim() ?? "";
    const streamedTranscript = this.streamedInsertedText.trim();

    if (!nextTranscript) {
      return "";
    }

    if (!streamedTranscript) {
      return nextTranscript;
    }

    if (nextTranscript.startsWith(streamedTranscript)) {
      return nextTranscript.slice(streamedTranscript.length).trim();
    }

    getLogger().warning(
      "Skipping final streamed reinsertion because the authoritative transcript diverged from live output",
    );
    return "";
  }

  private appendStreamedText(currentText: string, nextText: string): string {
    return currentText ? `${currentText} ${nextText}` : nextText;
  }

  handleInterimSegment(segment: string): void {
    const state = getAppState();

    const realtimeEnabled =
      getMyUserPreferences(state)?.realtimeOutputEnabled ?? false;
    const toneId = getToneIdToUse(state);
    if (!realtimeEnabled || toneId !== VERBATIM_TONE_ID) {
      return;
    }

    const sanitized = this.sanitizeTranscript(segment);
    if (!sanitized) {
      return;
    }

    this.streamedSegmentCount++;

    this.pasteQueue = this.pasteQueue.then(async () => {
      const text = sanitized;
      this.streamedProcessedText = this.appendStreamedText(
        this.streamedProcessedText,
        text,
      );
      this.streamedTranscriptReconciler.applyPartial({
        text: this.streamedProcessedText,
      });

      if (this.streamedOutputOutOfSync) {
        return;
      }

      try {
        await routeTranscriptOutput({
          text: `${text} `,
          mode: "dictation",
          currentAppId: this.currentAppId,
        });
        this.streamedInsertedText = this.appendStreamedText(
          this.streamedInsertedText,
          text,
        );
      } catch (error) {
        this.streamedOutputOutOfSync = true;
        getLogger().error(`Failed to paste interim segment: ${error}`);
      }
    });
  }

  private sanitizeTranscript(text: string): string | null {
    const state = getAppState();
    const replacementRules = Object.values(state.termById)
      .filter((term) => term.isReplacement)
      .map((term) => ({
        sourceValue: term.sourceValue,
        destinationValue: term.destinationValue,
      }));

    const afterReplacements = applyReplacements(text, replacementRules);
    return applySymbolConversions(afterReplacements);
  }

  validateAvailability(): Nullable<StrategyValidationError> {
    const state = getAppState();

    const transcriptionMode = getEffectiveTranscriptionMode(state);
    const generativeMode = getEffectivePostProcessingMode(state);
    const isCloud = transcriptionMode === "cloud" || generativeMode === "cloud";
    if (isCloud && getMemberExceedsLimitByState(state)) {
      return {
        title: getIntl().formatMessage({
          defaultMessage: "Word limit reached",
        }),
        body: getIntl().formatMessage({
          defaultMessage: "You've used all your free words for today.",
        }),
        action: "upgrade",
      };
    }

    return null;
  }

  async loadAppTarget(): Promise<void> {
    try {
      const appTarget = await tryRegisterCurrentAppTarget();
      this.currentAppId = appTarget?.id ?? null;
    } catch {
      getLogger().verbose("Failed to resolve current app target at start");
    }
  }

  async onBeforeStart(): Promise<void> {
    // load asyncronously, non-blocking
    this.loadAppTarget();
  }

  async setPhase(phase: OverlayPhase): Promise<void> {
    await invoke<void>("set_phase", { phase });
  }

  private async handleFinalStreamedTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    const sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);
    let remoteStatus: "sent" | null = null;
    let remoteDeviceId: string | null = null;

    await this.pasteQueue;

    if (sanitizedTranscript) {
      this.streamedTranscriptReconciler.applyFinal({
        text: sanitizedTranscript,
      });
    }

    const transcript =
      this.streamedTranscriptReconciler.getAuthoritativeTranscript() ||
      sanitizedTranscript;

    const tailToRoute = this.getStreamedTranscriptTail(transcript);

    if (tailToRoute) {
      const routed = await this.routeFinalTranscriptOutput(
        tailToRoute,
        args.currentApp?.id ?? this.currentAppId,
      );
      remoteStatus = routed.remoteStatus;
      remoteDeviceId = routed.remoteDeviceId;
    }

    getLogger().verbose(
      `Streaming dictation complete (${this.streamedSegmentCount} segments)`,
    );

    return {
      shouldContinue: false,
      transcript: transcript,
      sanitizedTranscript,
      postProcessMetadata: {},
      postProcessWarnings: [],
      remoteStatus,
      remoteDeviceId,
    };
  }

  private async handleFinalBulkTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    let transcript: string | null = null;
    let sanitizedTranscript: string | null = null;
    let postProcessMetadata: PostProcessMetadata = {};
    let postProcessWarnings: string[] = [];
    let remoteStatus: "sent" | null = null;
    let remoteDeviceId: string | null = null;

    try {
      sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);
      if (sanitizedTranscript) {
        if (args.processedTranscript) {
          transcript = args.processedTranscript;
          postProcessMetadata = args.serverPostProcessMetadata ?? {};
        } else {
          const result = await postProcessTranscript({
            rawTranscript: sanitizedTranscript,
            toneId: args.toneId,
            currentApp: args.currentApp
              ? {
                  id: args.currentApp.id,
                  name: args.currentApp.name,
                }
              : null,
            currentEditor: args.currentEditor ?? null,
            selectedText: args.selectedText ?? null,
            screenContext: args.screenContext ?? null,
            clipboardContext: args.clipboardContext ?? null,
          });

          transcript = result.transcript;
          postProcessMetadata = result.metadata;
          postProcessWarnings = result.warnings;
        }
      }

      if (transcript) {
        const routed = await this.routeFinalTranscriptOutput(
          transcript,
          args.currentApp?.id ?? null,
        );
        remoteStatus = routed.remoteStatus;
        remoteDeviceId = routed.remoteDeviceId;
      }
    } catch (error) {
      getLogger().error(`Failed to process transcription: ${error}`);

      const errorMessage =
        error instanceof Error ? error.message : "An error occurred.";
      postProcessWarnings.push(errorMessage);

      await showToast({
        message: "Transcription failed",
        toastType: "error",
      });
    }

    return {
      shouldContinue: false,
      transcript,
      sanitizedTranscript,
      postProcessMetadata,
      postProcessWarnings,
      remoteStatus,
      remoteDeviceId: remoteStatus ? remoteDeviceId : null,
    };
  }

  async handleTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    if (this.hasStreamedSegments) {
      return this.handleFinalStreamedTranscript(args);
    } else {
      return this.handleFinalBulkTranscript(args);
    }
  }

  async cleanup(): Promise<void> {
    this.streamedSegmentCount = 0;
    this.streamedProcessedText = "";
    this.streamedInsertedText = "";
    this.streamedTranscriptReconciler.reset();
    this.pasteQueue = Promise.resolve();
    this.currentAppId = null;
    this.streamedOutputOutOfSync = false;
  }
}
