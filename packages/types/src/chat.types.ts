import { Nullable } from "./common.types";

export type ChatMessageRole = "user" | "assistant" | "system";

export type ChatMessage = {
  id: string;
  conversationId: string;
  role: ChatMessageRole;
  content: string;
  createdAt: string;
  metadata: Nullable<Record<string, unknown>>;
};
