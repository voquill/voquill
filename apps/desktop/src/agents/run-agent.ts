import { AgentLoop } from "@repo/agent";
import type { AgentLlmProvider, AgentTool } from "@repo/agent";
import type { LlmMessage, LlmToolCall, ToolInfo } from "@voquill/types";
import { delayed } from "@voquill/utilities";
import { createChatMessage } from "../actions/chat.actions";
import {
  executeTool,
  getToolPermissionStatus,
  requestToolPermission,
} from "../actions/tool.actions";
import { getAgentRepo } from "../repos";
import { createAgentRunState } from "../state/agent.state";
import { getAppState, produceAppState } from "../store";
import { createTool } from "../tools";
import { modifyAgentState } from "../utils/agent.utils";
import { getLogger } from "../utils/log.utils";
import type { AgentTypeConfig } from "./agent-configs";

const POLL_INTERVAL_MS = 500;

export async function runAgent(
  conversationId: string,
  config: AgentTypeConfig,
): Promise<void> {
  const agentState = createAgentRunState(
    config.agentType,
    config.maxIterations,
  );
  produceAppState((draft) => {
    draft.agentStateByConversationId[conversationId] = agentState;
  });

  const provider = createLlmProvider();
  const tools = createAgentTools(conversationId, config);
  const messages = buildConversationMessages(conversationId);

  const loop = new AgentLoop({
    provider,
    tools,
    systemPrompt: config.systemPrompt,
    maxIterations: config.maxIterations,
  });

  let currentMessageId: string | null = null;
  let iterationText = "";
  let iterationToolCalls: LlmToolCall[] = [];
  let toolCallIndex = 0;
  const toolCallReasons = new Map<string, string>();

  try {
    for await (const event of loop.run(messages)) {
      switch (event.type) {
        case "iteration-start": {
          if (currentMessageId) {
            finalizeAssistantMessage(
              currentMessageId,
              iterationText,
              iterationToolCalls,
            );
          }

          currentMessageId = crypto.randomUUID();
          iterationText = "";
          iterationToolCalls = [];
          toolCallIndex = 0;

          produceAppState((draft) => {
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                s.iteration = event.iteration;
                s.status = "calling-llm";
                s.toolCalls = [];
                s.currentToolIndex = 0;
              },
            });

            draft.chatMessageById[currentMessageId!] = {
              id: currentMessageId!,
              conversationId,
              role: "assistant",
              content: "",
              createdAt: new Date().toISOString(),
              metadata: null,
            };
            const ids =
              draft.chatMessageIdsByConversationId[conversationId] ?? [];
            ids.push(currentMessageId!);
            draft.chatMessageIdsByConversationId[conversationId] = ids;

            draft.streamingMessageById[currentMessageId!] = {
              toolCalls: [],
              reasoning: "",
              isStreaming: true,
            };
          });
          break;
        }

        case "text-delta": {
          iterationText += event.text;
          produceAppState((draft) => {
            if (currentMessageId) {
              const msg = draft.chatMessageById[currentMessageId];
              if (msg) msg.content += event.text;
            }
          });
          break;
        }

        case "tool-call-start": {
          iterationToolCalls.push({
            id: event.toolCallId,
            name: event.toolName,
            arguments: JSON.stringify(event.args),
          });
          if (event.args.reason) {
            toolCallReasons.set(event.toolCallId, event.args.reason as string);
          }
          produceAppState((draft) => {
            if (currentMessageId) {
              const streaming = draft.streamingMessageById[currentMessageId];
              if (streaming) {
                streaming.isStreaming = false;
                streaming.toolCalls.push({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  done: false,
                });
              }
            }
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                s.status = "processing-tools";
                s.currentToolIndex = toolCallIndex;
                s.toolCalls.push({
                  toolCallId: event.toolCallId,
                  toolName: event.toolName,
                  params: event.args,
                  status: "pending",
                });
              },
            });
          });
          break;
        }

        case "tool-call-result": {
          toolCallIndex++;
          const reason = toolCallReasons.get(event.toolCallId);
          createChatMessage({
            id: crypto.randomUUID(),
            conversationId,
            role: "system",
            content: event.result,
            createdAt: new Date().toISOString(),
            metadata: {
              type: "tool-result",
              toolCallId: event.toolCallId,
              toolName: event.toolName,
              ...(reason && { reason }),
            },
          });
          produceAppState((draft) => {
            if (currentMessageId) {
              const streaming = draft.streamingMessageById[currentMessageId];
              if (streaming) {
                const tc = streaming.toolCalls.find(
                  (t) => t.toolCallId === event.toolCallId,
                );
                if (tc) tc.done = true;
              }
            }
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                const tc = s.toolCalls.find(
                  (t) => t.toolCallId === event.toolCallId,
                );
                if (tc) {
                  tc.status = event.isError ? "denied" : "done";
                  tc.result = { text: event.result };
                }
              },
            });
          });

          if (event.toolName === "end_conversation") {
            loop.abort();
          }
          break;
        }

        case "finish": {
          if (currentMessageId) {
            finalizeAssistantMessage(
              currentMessageId,
              iterationText,
              iterationToolCalls,
            );
          }
          produceAppState((draft) => {
            modifyAgentState({
              draft,
              conversationId,
              modify: (s) => {
                s.status = event.reason === "error" ? "error" : "done";
                if (event.error) s.error = event.error;
              },
            });
          });
          break;
        }
      }
    }
  } catch (error) {
    getLogger().error("Agent error", error);
    produceAppState((draft) => {
      modifyAgentState({
        draft,
        conversationId,
        modify: (s) => {
          s.status = "error";
          s.error = String(error);
        },
      });
    });
  } finally {
    if (currentMessageId) {
      produceAppState((draft) => {
        delete draft.streamingMessageById[currentMessageId!];
      });
    }
  }
}

function finalizeAssistantMessage(
  messageId: string,
  text: string,
  toolCalls: LlmToolCall[],
): void {
  const message = getAppState().chatMessageById[messageId];
  if (!message) return;

  const final = {
    ...message,
    content: text || "",
    metadata:
      toolCalls.length > 0
        ? ({ type: "reasoning", toolCalls } as Record<string, unknown>)
        : null,
  };

  produceAppState((draft) => {
    draft.chatMessageById[messageId] = final;
    delete draft.streamingMessageById[messageId];
  });
}

function createLlmProvider(): AgentLlmProvider {
  const { repo } = getAgentRepo();
  if (!repo) throw new Error("No LLM provider configured");
  return {
    async *streamChat(input) {
      yield* repo.streamChat(input);
    },
  };
}

function createAgentTools(
  conversationId: string,
  config: AgentTypeConfig,
): AgentTool[] {
  const state = getAppState();
  const toolFilter = config.getToolFilter(conversationId);
  const toolInfos = Object.values(state.toolInfoById).filter(toolFilter);

  return toolInfos.map((info) => ({
    name: info.id,
    description: `${info.description}. ${info.instructions}`,
    parameters: info.schema,
    async execute({ params, reason }) {
      return executeWithPermission(info, params, reason, conversationId);
    },
  }));
}

async function executeWithPermission(
  info: ToolInfo,
  params: Record<string, unknown>,
  reason: string,
  conversationId: string,
) {
  const tool = createTool(info);

  if (tool.getAlwaysAllow(params)) {
    try {
      const result = await executeTool(info.id, params);
      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  const permissionParams = { ...params, reason };
  const permissionId = requestToolPermission(
    info.id,
    permissionParams,
    conversationId,
  );

  produceAppState((draft) => {
    modifyAgentState({
      draft,
      conversationId,
      modify: (s) => {
        const tc = s.toolCalls[s.toolCalls.length - 1];
        if (tc) {
          tc.permissionId = permissionId;
          tc.status = "awaiting-permission";
        }
      },
    });
  });

  const resolution = await pollForPermission(permissionId);

  if (resolution === "allowed") {
    try {
      const result = await executeTool(info.id, params);
      return { success: true, result };
    } catch (err) {
      return {
        success: false,
        failureReason: err instanceof Error ? err.message : String(err),
      };
    }
  }

  return { success: false, failureReason: "Tool call was denied by user" };
}

async function pollForPermission(
  permissionId: string,
): Promise<"allowed" | "denied"> {
  while (true) {
    const result = getToolPermissionStatus(permissionId);
    if (result?.status === "allowed") return "allowed";
    if (result?.status === "denied") return "denied";
    await delayed(POLL_INTERVAL_MS);
  }
}

function buildConversationMessages(conversationId: string): LlmMessage[] {
  const state = getAppState();
  const messageIds = state.chatMessageIdsByConversationId[conversationId] ?? [];
  const messages: LlmMessage[] = [];

  for (const id of messageIds) {
    const msg = state.chatMessageById[id];
    if (!msg) continue;

    const metadata = msg.metadata as Record<string, unknown> | null;

    if (metadata?.type === "tool-result") {
      messages.push({
        role: "tool",
        toolCallId: metadata.toolCallId as string,
        content: msg.content,
      });
    } else if (msg.role === "assistant") {
      const toolCalls = metadata?.toolCalls as LlmToolCall[] | undefined;
      messages.push({
        role: "assistant",
        content: msg.content || undefined,
        ...(toolCalls && { toolCalls }),
      });
    } else if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content });
    }
  }

  return messages;
}
