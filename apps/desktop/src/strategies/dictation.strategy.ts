import { invoke } from "@tauri-apps/api/core";
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
  private pasteQueue: Promise<void> = Promise.resolve();
  private currentAppId: string | null = null;

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

    const isFirst = this.streamedSegmentCount === 0;
    this.streamedSegmentCount++;

    this.pasteQueue = this.pasteQueue.then(async () => {
      const text = sanitized;
      const textToPaste = text + " ";
      this.streamedProcessedText += (isFirst ? "" : " ") + text;

      try {
        await routeTranscriptOutput({
          text: textToPaste,
          mode: "dictation",
          currentAppId: this.currentAppId,
        });
      } catch (error) {
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

    await this.pasteQueue;

    const transcript = this.streamedProcessedText || sanitizedTranscript;
    getLogger().verbose(
      `Streaming dictation complete (${this.streamedSegmentCount} segments)`,
    );

    return {
      shouldContinue: false,
      transcript: transcript,
      sanitizedTranscript,
      postProcessMetadata: {},
      postProcessWarnings: [],
      remoteStatus: null,
      remoteDeviceId: null,
    };
  }

  /**
   * Live segments were already delivered before the stream broke, so the full
   * recovered transcript is handed over separately instead of being pasted on
   * top of them: to the paired device when remote output is on, otherwise to
   * the clipboard.
   */
  private async handleRecoveredStreamedTranscript(
    args: HandleTranscriptParams,
  ): Promise<HandleTranscriptResult> {
    const sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);
    const postProcessWarnings: string[] = [];
    const remoteDeviceId = this.getActiveRemoteTargetDeviceId();
    let remoteStatus: "sent" | null = null;

    await this.pasteQueue;

    if (sanitizedTranscript && !args.signal.aborted) {
      getLogger().warning(
        `Live output was interrupted after ${this.streamedSegmentCount} segments; delivering recovered transcript ${remoteDeviceId ? "to paired device" : "to clipboard"}`,
      );
      try {
        if (remoteDeviceId) {
          const result = await routeTranscriptOutput({
            text: sanitizedTranscript.trim() + " ",
            mode: "dictation",
            currentAppId: args.currentApp?.id ?? null,
          });
          remoteStatus = result.remote && result.delivered ? "sent" : null;
          postProcessWarnings.push(
            "Live output was interrupted; the full recovered transcript was sent to the paired device",
          );
        } else {
          await invoke<void>("copy_to_clipboard", {
            text: sanitizedTranscript,
          });
          postProcessWarnings.push(
            "Live output was interrupted; the full recovered transcript was copied to the clipboard",
          );
        }
        await showToast({
          message: remoteDeviceId
            ? getIntl().formatMessage({
                defaultMessage:
                  "Connection dropped mid-dictation. Full transcript sent to your paired device.",
              })
            : getIntl().formatMessage({
                defaultMessage:
                  "Connection dropped mid-dictation. Full transcript copied to clipboard.",
              }),
          toastType: "info",
          duration: 6_000,
        });
      } catch (error) {
        getLogger().error(`Failed to deliver recovered transcript: ${error}`);
        showErrorSnackbar(error);
      }
    }

    return {
      shouldContinue: false,
      transcript: sanitizedTranscript,
      sanitizedTranscript,
      postProcessMetadata: {},
      postProcessWarnings,
      remoteStatus,
      remoteDeviceId: remoteStatus ? remoteDeviceId : null,
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
    const remoteDeviceId = this.getActiveRemoteTargetDeviceId();

    try {
      sanitizedTranscript = this.sanitizeTranscript(args.rawTranscript);
      if (sanitizedTranscript) {
        if (args.processedTranscript) {
          transcript = args.processedTranscript;
          postProcessMetadata = args.serverPostProcessMetadata ?? {};
        } else {
          try {
            const result = await postProcessTranscript({
              rawTranscript: sanitizedTranscript,
              toneId: args.toneId,
            });

            transcript = result.transcript;
            postProcessMetadata = result.metadata;
            postProcessWarnings = result.warnings;
          } catch (error) {
            getLogger().error(
              `Post-processing failed, using unprocessed transcript: ${error}`,
            );
            transcript = sanitizedTranscript;
            postProcessWarnings.push(
              `Post-processing failed, used unprocessed transcript: ${error instanceof Error ? error.message : String(error)}`,
            );
          }
        }
      }

      if (transcript && !args.signal.aborted) {
        await new Promise<void>((resolve) => setTimeout(resolve, 20));
        try {
          getLogger().verbose(
            `Routing transcript output (${transcript.length} chars, app=${args.currentApp?.id ?? "none"})`,
          );

          const textToPaste = transcript.trim() + " ";
          const result = await routeTranscriptOutput({
            text: textToPaste,
            mode: "dictation",
            currentAppId: args.currentApp?.id ?? null,
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
          showErrorSnackbar(
            error instanceof Error
              ? error.message
              : String(error) || "Unable to insert transcription.",
          );
        }
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
    if (!this.hasStreamedSegments) {
      return this.handleFinalBulkTranscript(args);
    }
    if (args.transcriptionRecovered) {
      return this.handleRecoveredStreamedTranscript(args);
    }
    return this.handleFinalStreamedTranscript(args);
  }

  async cleanup(): Promise<void> {
    // Nothing to clean up for dictation
  }
}
