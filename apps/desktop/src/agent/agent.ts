import { retry } from "@repo/utilities";
import type { ZodType, z } from "zod";
import type {
  BaseGenerateTextRepo,
  GenerateTextInput,
} from "../repos/generate-text.repo";
import { BaseTool } from "../tools/base.tool";
import type {
  AgentMessage,
  AgentRunOptions,
  AgentRunResult,
  DecisionResponse,
  ToolExecution,
  ToolResult,
} from "../types/agent.types";
import {
  DecisionResponseSchema,
  FinalResponseSchema,
} from "../types/agent.types";
import {
  DECISION_JSON_SCHEMA,
  FINAL_RESPONSE_JSON_SCHEMA,
  buildDecisionSystemPrompt,
  buildFinalResponseSystemPrompt,
  buildToolArgsSystemPrompt,
  buildUserPrompt,
} from "./agent.prompt";

const MAX_ITERATIONS = 16;
const LLM_RETRIES = 3;
const LLM_RETRY_DELAY_MS = 500;

export class Agent {
  private history: AgentMessage[] = [];

  constructor(
    private repo: BaseGenerateTextRepo,
    private tools: BaseTool[] = [],
  ) {}

  private generateTextWithRetries<T extends ZodType>(
    schema: T,
    input: GenerateTextInput,
  ): Promise<z.infer<T>> {
    return retry({
      fn: async () => {
        const output = await this.repo.generateText(input);
        const parsed = JSON.parse(output.text);
        return schema.parse(parsed);
      },
      retries: LLM_RETRIES,
      delay: LLM_RETRY_DELAY_MS,
    });
  }

  private toolRecord(): Record<string, BaseTool> {
    const record: Record<string, BaseTool> = {};
    for (const tool of this.tools) {
      record[tool.name] = tool;
    }
    return record;
  }

  getHistory(): AgentMessage[] {
    return [...this.history];
  }

  clearHistory(): void {
    this.history = [];
  }

  async run(
    userInput: string,
    options?: AgentRunOptions,
  ): Promise<AgentRunResult> {
    this.history.push({ type: "user", content: userInput });

    const originalInput = userInput;
    const toolExecutions: ToolExecution[] = [];
    const decisionSystemPrompt = buildDecisionSystemPrompt(this.tools);

    const buildCurrentPrompt = (): string => {
      if (toolExecutions.length === 0) {
        return originalInput;
      }
      const toolsSummary = toolExecutions
        .map(
          (t) =>
            `- ${t.name} [${t.didSucceed ? "SUCCESS" : "FAILED"}]: ${JSON.stringify(t.output)}`,
        )
        .join("\n");
      return `${originalInput}

## Tools Already Called
${toolsSummary}

IMPORTANT: If a tool succeeded, the task for that tool is COMPLETE. Do NOT call the same tool again. Choose "respond" to finish.`;
    };

    try {
      for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
        const userPrompt = buildUserPrompt(this.history, buildCurrentPrompt());
        const decision = await this.callDecisionLLM(
          decisionSystemPrompt,
          userPrompt,
        );

        const lastTool = toolExecutions.at(-1);
        const isLooping =
          lastTool?.didSucceed && lastTool.name === decision.choice;

        if (decision.choice === "respond" || isLooping) {
          const reasoning = isLooping
            ? "Task complete - " + lastTool?.name + " succeeded"
            : decision.reasoning;
          const response = await this.callFinalResponseLLM(
            userPrompt,
            reasoning,
          );
          this.history.push({
            type: "assistant",
            tools: toolExecutions,
            response,
            isError: false,
          });
          return { response, history: this.getHistory(), isError: false };
        }

        const tool = this.toolRecord()[decision.choice];
        if (!tool) {
          throw new Error(`Tool not found: ${decision.choice}`);
        }

        const toolArgs = await this.callToolArgsLLM(
          tool,
          userPrompt,
          decision.reasoning,
        );

        const toolResult = await this.executeTool(tool, toolArgs);

        const execution: ToolExecution = {
          name: tool.name,
          displayName: tool.displayName,
          input: toolArgs,
          output: toolResult.output,
          didSucceed: toolResult.success,
        };
        toolExecutions.push(execution);
        options?.onToolExecuted?.(execution);
      }

      throw new Error(
        "Maximum iterations reached without completing the task.",
      );
    } catch (error) {
      let message: string;
      if (error instanceof Error) {
        message = error.message;
      } else {
        message = "An unexpected error occurred.";
      }

      this.history.push({
        type: "assistant",
        tools: toolExecutions,
        response: message,
        isError: true,
      });

      return { response: message, history: this.getHistory(), isError: true };
    }
  }

  private async callDecisionLLM(
    system: string,
    prompt: string,
  ): Promise<DecisionResponse> {
    return this.generateTextWithRetries(DecisionResponseSchema, {
      system,
      prompt,
      jsonResponse: {
        name: "decision_response",
        description: "Decision about what action to take",
        schema: DECISION_JSON_SCHEMA,
      },
    });
  }

  private async callFinalResponseLLM(
    prompt: string,
    reasoning: string,
  ): Promise<string> {
    const system = buildFinalResponseSystemPrompt(reasoning);
    const result = await this.generateTextWithRetries(FinalResponseSchema, {
      system,
      prompt,
      jsonResponse: {
        name: "final_response",
        description: "Final response to the user",
        schema: FINAL_RESPONSE_JSON_SCHEMA,
      },
    });
    return result.response;
  }

  private async callToolArgsLLM(
    tool: BaseTool,
    prompt: string,
    reasoning: string,
  ): Promise<Record<string, unknown>> {
    const system = buildToolArgsSystemPrompt(tool, reasoning);
    return this.generateTextWithRetries(tool.inputSchema, {
      system,
      prompt,
      jsonResponse: {
        name: "tool_args",
        description: `Arguments for the ${tool.name} tool`,
        schema: tool.getInputJsonSchema(),
      },
    });
  }

  private async executeTool(
    tool: BaseTool,
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    try {
      return await tool.execute(args);
    } catch (error) {
      return {
        success: false,
        output: { error: `Tool execution error: ${String(error)}` },
      };
    }
  }
}
