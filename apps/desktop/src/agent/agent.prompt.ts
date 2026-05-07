import dayjs from "dayjs";
import zodToJsonSchema from "zod-to-json-schema";
import { getAppState } from "../store";
import { BaseTool } from "../tools/base.tool";
import type { AgentMessage } from "../types/agent.types";
import {
  DecisionResponseSchema,
  FinalResponseSchema,
} from "../types/agent.types";
import { getMyUserName } from "../utils/user.utils";

const extractSchema = (
  schema: ReturnType<typeof zodToJsonSchema>,
  name: string,
): Record<string, unknown> => {
  return (schema.definitions?.[name] as Record<string, unknown>) ?? schema;
};

const rawDecisionSchema = zodToJsonSchema(DecisionResponseSchema, {
  name: "DecisionResponse",
  $refStrategy: "none",
});
export const DECISION_JSON_SCHEMA = extractSchema(
  rawDecisionSchema,
  "DecisionResponse",
);

const rawFinalResponseSchema = zodToJsonSchema(FinalResponseSchema, {
  name: "FinalResponse",
  $refStrategy: "none",
});
export const FINAL_RESPONSE_JSON_SCHEMA = extractSchema(
  rawFinalResponseSchema,
  "FinalResponse",
);

const getCommonPromptContext = (): string => {
  const username = getMyUserName(getAppState());
  const now = new Date();
  const timezoneAbbr = now
    .toLocaleTimeString("en-US", { timeZoneName: "short" })
    .split(" ")
    .pop();
  return `
CRITICAL CONTEXT (DO NOT FORGET!):
The user's name is "${username}". YOU MUST SIGN EMAILS WITH THIS NAME.
The current date is ${dayjs().format("MMMM D, YYYY (dddd)")} at ${dayjs().format("h:mm A")} ${timezoneAbbr}.
`;
};

export const buildDecisionSystemPrompt = (tools: BaseTool[]): string => {
  const toolNames = tools.map((t) => t.name);
  const toolDescriptions = tools
    .map((t) => `- ${t.name}: ${t.description}`)
    .join("\n");

  return `You are a helpful assistant that decides how to respond to user requests.

## Available Tools
${toolDescriptions}

## Your Task
Analyze the user's request and conversation history, then decide what to do next.

## Response Format
Respond with JSON only:
{
  "reasoning": "Brief explanation of why you chose this action",
  "choice": "respond" | "${toolNames.join('" | "')}"
}

## Rules
- If you're not sure what the user is referring to, use get_context to gather more information.
- Use "respond" when you need to communicate with the user or have completed their request.
- Read the tool descriptions carefully - they explain when and how to use each tool.

${getCommonPromptContext()}
`;
};

export const buildFinalResponseSystemPrompt = (reasoning: string): string => {
  return `You are a helpful assistant that responds to the user.

You are responding to the user because of this reason: ${reasoning}

## Response Format
Respond with JSON only:
{
  "response": "What you want to say to the user"
}

## Rules
- Be concise and helpful
- If you just executed a tool, briefly confirm what you did or ask for next steps as appropriate
- If you're answering a question, provide the answer directly
- CRITICAL: You must NEVER include draft content in your responses. Drafts are displayed separately by the system. Your response should only contain a brief message like "How does this look?" - never the draft text itself.

## Draft Content
If you used the draft tool, your response must ONLY be a short question like "How does this look?" or "Does this work?".
DO NOT repeat, summarize, or include ANY of the draft text. The draft is shown separately by the system.

${getCommonPromptContext()}
`;
};

export const buildToolArgsSystemPrompt = (
  tool: BaseTool,
  reasoning: string,
): string => {
  const jsonSchema = tool.getInputJsonSchema();

  return `You are a helpful assistant. You need to provide arguments for the "${tool.name}" tool.

The reason for calling this tool is: ${reasoning}

## Tool Description
${tool.description}

## Parameters Schema
${JSON.stringify(jsonSchema, null, 2)}

## Response Format
Respond with JSON matching the parameters schema above.

## Rules
- Provide all required parameters
- Use appropriate values based on the conversation context

${getCommonPromptContext()}
`;
};

export const formatHistory = (messages: AgentMessage[]): string => {
  return messages
    .map((msg) => {
      if (msg.type === "user") {
        return `User: ${msg.content}`;
      }
      const toolsSummary =
        msg.tools.length > 0
          ? `[Tools used: ${msg.tools.map((t) => `${t.name}(${JSON.stringify(t.input)}) → ${JSON.stringify(t.output)}`).join(", ")}]\n`
          : "";
      return `Assistant: ${toolsSummary}${msg.response}`;
    })
    .join("\n\n");
};

export const buildUserPrompt = (
  history: AgentMessage[],
  currentInput: string,
): string => {
  const historyText =
    history.length > 0
      ? `## Conversation History\n${formatHistory(history)}\n\n`
      : "";

  return `${historyText}## Current User Input
${currentInput}`;
};
