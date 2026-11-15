import type { LlmChatInput, LlmStreamEvent } from "@voquill/types";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { INITIAL_APP_STATE } from "../state/app.state";
import { getAppState, setAppState } from "../store";
import { sendChatMessage } from "./chat.actions";

const llm = vi.hoisted(() => ({
  inputs: [] as LlmChatInput[],
  responses: [] as LlmStreamEvent[][],
}));

vi.mock("../repos", () => ({
  getAgentRepo: () => ({
    repo: {
      async *streamChat(input: LlmChatInput) {
        llm.inputs.push(structuredClone(input));
        yield* llm.responses.shift() ?? [];
      },
    },
  }),
}));

const CONVERSATION_ID = "pill-conversation";

const getConversationMessages = () => {
  const state = getAppState();
  return (state.chatMessageIdsByConversationId[CONVERSATION_ID] ?? []).map(
    (id) => state.chatMessageById[id],
  );
};

describe("sendChatMessage", () => {
  beforeEach(() => {
    llm.inputs = [];
    llm.responses = [];
    setAppState({ ...INITIAL_APP_STATE, pillConversationId: CONVERSATION_ID });
  });

  it("keeps the agent conversation in app state across turns", async () => {
    llm.responses = [
      [
        {
          type: "tool-call",
          id: "call-1",
          name: "missing_tool",
          arguments: "{}",
        },
        { type: "finish", finishReason: "tool-calls" },
      ],
      [
        { type: "text-delta", text: "Done" },
        { type: "finish", finishReason: "stop" },
      ],
      [
        { type: "text-delta", text: "Again" },
        { type: "finish", finishReason: "stop" },
      ],
    ];

    await sendChatMessage(CONVERSATION_ID, "Do the thing");

    expect(getConversationMessages().map((m) => [m.role, m.content])).toEqual([
      ["user", "Do the thing"],
      ["assistant", ""],
      ["system", "Unknown tool: missing_tool"],
      ["assistant", "Done"],
    ]);
    expect(getConversationMessages()[1].metadata).toEqual({
      type: "reasoning",
      toolCalls: [{ id: "call-1", name: "missing_tool", arguments: "{}" }],
    });
    expect(getAppState().streamingMessageById).toEqual({});
    expect(getAppState().agentStateByConversationId).toEqual({});

    await sendChatMessage(CONVERSATION_ID, "Once more");

    expect(llm.inputs[2].messages.slice(1)).toEqual([
      { role: "user", content: "Do the thing" },
      {
        role: "assistant",
        content: undefined,
        toolCalls: [{ id: "call-1", name: "missing_tool", arguments: "{}" }],
      },
      {
        role: "tool",
        toolCallId: "call-1",
        content: "Unknown tool: missing_tool",
      },
      { role: "assistant", content: "Done" },
      { role: "user", content: "Once more" },
    ]);
    expect(getConversationMessages().at(-1)?.content).toBe("Again");
  });

  it("clears the agent run state when the agent fails", async () => {
    llm.responses = [[{ type: "error", error: "boom" }]];

    await sendChatMessage(CONVERSATION_ID, "Hello");

    expect(getConversationMessages().map((m) => m.role)).toEqual([
      "user",
      "assistant",
    ]);
    expect(getAppState().agentStateByConversationId).toEqual({});
  });
});
