import type { Nullable } from "@voquill/types";
import { invoke } from "@tauri-apps/api/core";
import { sendChatMessage } from "../actions/chat.actions";
import { showToast } from "../actions/toast.actions";
import { getIntl } from "../i18n";
import { getAppState, produceAppState } from "../store";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyValidationError,
} from "../types/strategy.types";
import { getIsAssistantModeEnabled } from "../utils/assistant-mode.utils";
import { createId } from "../utils/id.utils";
import { getLogger } from "../utils/log.utils";
import { getMemberExceedsLimitByState } from "../utils/member.utils";
import { getAgentModePrefs } from "../utils/user.utils";
import { BaseStrategy } from "./base.strategy";

export class AgentStrategy extends BaseStrategy {
  private conversationId: string | null = null;

  shouldStoreTranscript(): boolean {
    return false;
  }

  validateAvailability(): Nullable<StrategyValidationError> {
    const state = getAppState();

    if (!getIsAssistantModeEnabled(state)) {
      return {
        title: getIntl().formatMessage({
          defaultMessage: "Agent mode disabled",
        }),
        body: getIntl().formatMessage({
          defaultMessage: "Enable agent mode in settings to use this feature.",
        }),
        action: "open_agent_settings",
      };
    }

    const prefs = getAgentModePrefs(getAppState());
    if (prefs.mode === "cloud" && getMemberExceedsLimitByState(state)) {
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

  async onBeforeStart(): Promise<void> {
    if (!this.conversationId) {
      const conversationId = createId();
      this.conversationId = conversationId;
      produceAppState((draft) => {
        draft.pillConversationId = conversationId;
      });
    }
  }

  async setPhase(phase: OverlayPhase): Promise<void> {
    await invoke<void>("set_phase", { phase });
  }

  async handleTranscript({
    rawTranscript,
    signal,
  }: HandleTranscriptParams): Promise<HandleTranscriptResult> {
    if (!this.conversationId || signal.aborted) {
      return {
        shouldContinue: false,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    }

    try {
      getLogger().info(`Sending chat message (${rawTranscript.length} chars)`);
      await sendChatMessage(this.conversationId, rawTranscript);

      return {
        shouldContinue: true,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    } catch (error) {
      getLogger().error(`Chat message failed: ${error}`);
      await showToast({
        message: getIntl().formatMessage({
          defaultMessage: "Chat request failed",
        }),
        toastType: "error",
      });
      return {
        shouldContinue: true,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    }
  }

  async cleanup(): Promise<void> {
    getLogger().verbose("Cleaning up agent strategy");
    this.conversationId = null;
    produceAppState((draft) => {
      draft.pillConversationId = null;
    });
  }
}
