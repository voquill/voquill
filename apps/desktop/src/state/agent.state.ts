export type AgentToolCallState = {
  toolCallId: string;
  toolName: string;
  params: Record<string, unknown>;
  permissionId?: string;
  result?: Record<string, unknown>;
  status: "pending" | "awaiting-permission" | "executing" | "done" | "denied";
};

export type AgentStatus =
  | "idle"
  | "calling-llm"
  | "processing-tools"
  | "done"
  | "error";

export type AgentRunState = {
  status: AgentStatus;
  agentType: string;
  iteration: number;
  maxIterations: number;
  toolCalls: AgentToolCallState[];
  currentToolIndex: number;
  error?: string;
};

export const createAgentRunState = (
  agentType: string,
  maxIterations = 10,
): AgentRunState => ({
  status: "idle",
  agentType,
  iteration: 0,
  maxIterations,
  toolCalls: [],
  currentToolIndex: 0,
});
