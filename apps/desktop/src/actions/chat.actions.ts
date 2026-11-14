import type { ChatMessage } from "@voquill/types";
import { CHAT_AGENT_CONFIG, runAgent } from "../agents";
import { produceAppState } from "../store";

export const createChatMessage = (message: ChatMessage): void => {
  produceAppState((draft) => {
    draft.chatMessageById[message.id] = message;
    const ids =
      draft.chatMessageIdsByConversationId[message.conversationId] ?? [];
    ids.push(message.id);
    draft.chatMessageIdsByConversationId[message.conversationId] = ids;
  });
};

export const sendChatMessage = async (
  conversationId: string,
  text: string,
): Promise<void> => {
  createChatMessage({
    id: crypto.randomUUID(),
    conversationId,
    role: "user",
    content: text,
    createdAt: new Date().toISOString(),
    metadata: null,
  });

  try {
    await runAgent(conversationId, CHAT_AGENT_CONFIG);
  } finally {
    produceAppState((draft) => {
      delete draft.agentStateByConversationId[conversationId];
    });
  }
};
