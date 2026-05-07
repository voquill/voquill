import type { Nullable } from "@repo/types";
import { showToast } from "../actions/toast.actions";
import { OpenClawClient } from "../openclaw/openclaw-client";
import { produceAppState } from "../store";
import type { AgentWindowMessage } from "../types/agent-window.types";
import type { OverlayPhase } from "../types/overlay.types";
import type {
  HandleTranscriptParams,
  HandleTranscriptResult,
  StrategyContext,
  StrategyValidationError,
} from "../types/strategy.types";
import { getLogger } from "../utils/log.utils";
import { BaseStrategy } from "./base.strategy";

export class OpenClawAgentStrategy extends BaseStrategy {
  private uiMessages: AgentWindowMessage[] = [];
  private isFirstTurn = true;
  private client: OpenClawClient | null = null;
  private gatewayUrl: string;
  private token: string;

  constructor(context: StrategyContext, gatewayUrl: string, token: string) {
    super(context);
    this.gatewayUrl = gatewayUrl;
    this.token = token;
  }

  shouldStoreTranscript(): boolean {
    return false;
  }

  validateAvailability(): Nullable<StrategyValidationError> {
    return null;
  }

  private updateWindowState(messages: AgentWindowMessage[] | null): void {
    produceAppState((draft) => {
      draft.agent.windowState = messages
        ? {
            messages: messages.map((m) => ({
              ...m,
              tools: m.tools ? [...m.tools] : undefined,
            })),
          }
        : null;
    });
  }

  async onBeforeStart(): Promise<void> {
    if (this.isFirstTurn) {
      this.updateWindowState(null);
      this.isFirstTurn = false;

      getLogger().info("Connecting to OpenClaw gateway...");
      this.client = new OpenClawClient(this.gatewayUrl, this.token);
      try {
        await this.client.connect();
        getLogger().info("Connected to OpenClaw gateway");
      } catch (error) {
        getLogger().error(`Failed to connect to OpenClaw: ${error}`);
        this.client = null;
        throw error;
      }
    }
  }

  async setPhase(phase: OverlayPhase): Promise<void> {
    produceAppState((draft) => {
      draft.agent.overlayPhase = phase;
    });
  }

  async handleTranscript({
    rawTranscript,
    loadingToken,
  }: HandleTranscriptParams): Promise<HandleTranscriptResult> {
    const clearLoadingToken = () => {
      if (
        loadingToken &&
        this.context.overlayLoadingTokenRef.current === loadingToken
      ) {
        this.context.overlayLoadingTokenRef.current = null;
      }
    };

    if (!this.client?.isConnected()) {
      getLogger().warning("OpenClaw not connected, attempting reconnect...");
      this.client = new OpenClawClient(this.gatewayUrl, this.token);
      try {
        await this.client.connect();
      } catch (error) {
        clearLoadingToken();
        await showToast({
          title: "OpenClaw connection failed",
          message: String(error),
          toastType: "error",
        });
        return {
          shouldContinue: false,
          transcript: null,
          sanitizedTranscript: null,
          postProcessMetadata: {},
          postProcessWarnings: [],
        };
      }
    }

    try {
      this.uiMessages.push({ text: rawTranscript, sender: "me" });
      this.updateWindowState(this.uiMessages);

      const agentMessage: AgentWindowMessage = {
        text: "",
        sender: "agent",
        tools: ["OpenClaw"],
      };
      this.uiMessages.push(agentMessage);

      getLogger().info(`Sending to OpenClaw: ${rawTranscript.length} chars`);
      const response = await this.client.sendMessage(
        rawTranscript,
        (deltaText) => {
          agentMessage.text = deltaText;
          this.updateWindowState(this.uiMessages);
        },
      );

      this.uiMessages.pop();
      this.uiMessages.push({
        text: response,
        sender: "agent",
        tools: ["OpenClaw"],
      });
      this.updateWindowState(this.uiMessages);

      getLogger().info(`OpenClaw response: ${response.length} chars`);
      clearLoadingToken();

      return {
        shouldContinue: true,
        transcript: null,
        sanitizedTranscript: null,
        postProcessMetadata: {},
        postProcessWarnings: [],
      };
    } catch (error) {
      getLogger().error(`OpenClaw request failed: ${error}`);
      const errorMessage =
        error instanceof Error ? error.message : "An error occurred.";

      this.uiMessages.pop();
      this.uiMessages.push({
        text: errorMessage,
        sender: "agent",
        isError: true,
      });
      this.updateWindowState(this.uiMessages);

      clearLoadingToken();

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
    getLogger().verbose("Cleaning up OpenClaw agent strategy");
    this.client?.disconnect();
    this.client = null;
    this.uiMessages = [];
    this.isFirstTurn = true;
    produceAppState((draft) => {
      draft.agent.overlayPhase = "idle";
      draft.agent.windowState = null;
    });
  }
}
