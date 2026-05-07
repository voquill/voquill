import { batchAsync } from "@repo/utilities";
import { fetch } from "@tauri-apps/plugin-http";
import { z } from "zod";
import type { ToolResult } from "../types/agent.types";
import { BaseTool } from "./base.tool";

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

type JsonRpcResponse<T = unknown> = {
  jsonrpc: "2.0";
  id: number;
  result?: T;
  error?: { code: number; message: string; data?: unknown };
};

type McpToolDefinition = {
  name: string;
  description?: string;
  inputSchema: {
    type: "object";
    properties?: Record<string, unknown>;
    required?: string[];
  };
};

type McpToolsListResult = {
  tools: McpToolDefinition[];
};

type McpCallToolResult = {
  content: Array<{
    type: string;
    text?: string;
    data?: string;
    mimeType?: string;
  }>;
  isError?: boolean;
};

function jsonSchemaToZod(schema: Record<string, unknown>): z.ZodType {
  const properties = (schema.properties ?? {}) as Record<
    string,
    Record<string, unknown>
  >;
  const required = (schema.required ?? []) as string[];

  const shape: Record<string, z.ZodType> = {};

  for (const [key, prop] of Object.entries(properties)) {
    let fieldSchema: z.ZodType;

    switch (prop.type) {
      case "string":
        fieldSchema = z.string();
        break;
      case "number":
        fieldSchema = z.number();
        break;
      case "integer":
        fieldSchema = z.number().int();
        break;
      case "boolean":
        fieldSchema = z.boolean();
        break;
      case "array":
        fieldSchema = z.array(z.unknown());
        break;
      case "object":
        fieldSchema = z.record(z.unknown());
        break;
      default:
        fieldSchema = z.unknown();
    }

    if (prop.description && typeof prop.description === "string") {
      fieldSchema = fieldSchema.describe(prop.description);
    }

    if (!required.includes(key)) {
      fieldSchema = fieldSchema.optional();
    }

    shape[key] = fieldSchema;
  }

  return z.object(shape);
}

class McpProxyTool extends BaseTool {
  readonly name: string;
  readonly displayName: string;
  readonly description: string;
  readonly inputSchema: z.ZodType;
  readonly outputSchema = z.object({
    content: z.array(
      z.object({
        type: z.string(),
        text: z.string().optional(),
      }),
    ),
  });

  constructor(
    private client: McpClient,
    private toolDef: McpToolDefinition,
  ) {
    super();
    this.name = toolDef.name;
    this.displayName = toolDef.name
      .split(/[-_]/)
      .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
      .join(" ");
    this.description = toolDef.description ?? `MCP tool: ${toolDef.name}`;
    this.inputSchema = jsonSchemaToZod(toolDef.inputSchema);
  }

  protected async execInternal(
    args: Record<string, unknown>,
  ): Promise<ToolResult> {
    const result = await this.client.callTool(this.toolDef.name, args);

    if (result.isError) {
      const errorText = result.content
        .filter((c) => c.type === "text" && c.text)
        .map((c) => c.text)
        .join("\n");
      return {
        success: false,
        output: { error: errorText || "Tool execution failed" },
      };
    }

    const textContent = result.content
      .filter((c) => c.type === "text" && c.text)
      .map((c) => c.text)
      .join("\n");

    return {
      success: true,
      output: { result: textContent, content: result.content },
    };
  }
}

type McpServerConfig = {
  url: string;
  headers?: Record<string, string>;
};

class McpClient {
  private requestId = 0;
  private initialized = false;

  constructor(private config: McpServerConfig) {}

  private extractJsonFromSse(text: string): string {
    const lines = text.split("\n");
    for (const line of lines) {
      if (line.startsWith("data: ")) {
        return line.slice(6);
      }
    }
    return text;
  }

  private async request<T>(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<T> {
    const request: JsonRpcRequest = {
      jsonrpc: "2.0",
      id: ++this.requestId,
      method,
      params,
    };

    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(request),
    });

    const text = await response.text();

    if (!response.ok) {
      throw new Error(
        `MCP request failed: ${response.status} ${response.statusText}\n${text}`,
      );
    }

    let json: JsonRpcResponse<T>;
    try {
      const jsonText = this.extractJsonFromSse(text);
      json = JSON.parse(jsonText) as JsonRpcResponse<T>;
    } catch {
      throw new Error(`MCP response is not JSON: ${text.slice(0, 500)}`);
    }

    if (json.error) {
      throw new Error(`MCP error: ${json.error.message}`);
    }

    return json.result as T;
  }

  private async notify(
    method: string,
    params?: Record<string, unknown>,
  ): Promise<void> {
    const request = { jsonrpc: "2.0", method, params };

    const response = await fetch(this.config.url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...this.config.headers,
      },
      body: JSON.stringify(request),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(
        `MCP notification failed: ${response.status} ${response.statusText}\n${text}`,
      );
    }
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;

    await this.request("initialize", {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "voquill", version: "0.1.0" },
    });

    await this.notify("notifications/initialized");
    this.initialized = true;
  }

  async listTools(): Promise<McpToolDefinition[]> {
    const result = await this.request<McpToolsListResult>("tools/list");
    return result.tools;
  }

  async callTool(
    name: string,
    args: Record<string, unknown>,
  ): Promise<McpCallToolResult> {
    return this.request<McpCallToolResult>("tools/call", {
      name,
      arguments: args,
    });
  }
}

const getToolsForServer = async (
  config: McpServerConfig,
): Promise<BaseTool[]> => {
  const client = new McpClient(config);
  await client.initialize();
  const toolDefs = await client.listTools();
  return toolDefs.map((def) => new McpProxyTool(client, def));
};

export type { McpServerConfig };

export const getToolsForServers = async (
  servers: McpServerConfig[],
): Promise<BaseTool[]> => {
  return (
    await batchAsync(
      16,
      servers.map(
        (config) => () =>
          getToolsForServer(config).catch((error) => {
            console.error(
              `Failed to get tools from MCP server ${config.url}:`,
              error,
            );
            return [];
          }),
      ),
    )
  ).flat();
};
