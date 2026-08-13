import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { DiscoveryResult, JsonObject } from "../domain.js";
import { AppError } from "../errors.js";

function errorMessage(error: unknown): string {
  if (!(error instanceof Error)) return "Unknown MCP error";
  const cause = "cause" in error ? (error as Error & { cause?: unknown }).cause : undefined;
  return cause ? `${error.message}: ${errorMessage(cause)}` : error.message;
}

export interface ToolCallResult {
  content: unknown[];
  isError?: boolean;
  structuredContent?: JsonObject;
  [key: string]: unknown;
}

export interface McpConnector {
  discover(endpoint: string, token: string | null, timeoutMs?: number): Promise<DiscoveryResult>;
  probe(endpoint: string, token: string | null, timeoutMs?: number): Promise<boolean>;
  callTool(endpoint: string, token: string | null, name: string, arguments_: JsonObject, timeoutMs: number): Promise<ToolCallResult>;
}

export class SdkMcpConnector implements McpConnector {
  private async withClient<T>(endpoint: string, token: string | null, timeoutMs: number, work: (client: Client) => Promise<T>): Promise<T> {
    const client = new Client({ name: "linkcli-gateway", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(endpoint), {
      requestInit: token ? { headers: { Authorization: `Bearer ${token}` } } : undefined,
      reconnectionOptions: { initialReconnectionDelay: 250, maxReconnectionDelay: 250, reconnectionDelayGrowFactor: 1, maxRetries: 0 },
    });
    const abort = new AbortController();
    const timer = setTimeout(() => abort.abort(), timeoutMs);
    try {
      await client.connect(transport, { signal: abort.signal });
      return await work(client);
    } catch (error) {
      if (abort.signal.aborted) throw new AppError("DOWNSTREAM_TIMEOUT", "Downstream MCP request timed out", 504);
      const message = errorMessage(error);
      if (/401|403|unauthor/i.test(message)) throw new AppError("DOWNSTREAM_AUTH_FAILED", "Downstream MCP authentication failed", 502);
      if (/fetch failed|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|network|socket|connect/i.test(message)) throw new AppError("DOWNSTREAM_CONNECTION_FAILED", "Downstream MCP connection failed", 502);
      if (error instanceof AppError) throw error;
      throw new AppError("DOWNSTREAM_PROTOCOL_ERROR", "Downstream MCP protocol error", 502);
    } finally {
      clearTimeout(timer);
      await client.close().catch(() => undefined);
    }
  }

  async discover(endpoint: string, token: string | null, timeoutMs = 10_000): Promise<DiscoveryResult> {
    return this.withClient(endpoint, token, timeoutMs, async (client) => {
      const result = await client.listTools(undefined, { timeout: timeoutMs });
      return {
        protocolVersion: "streamable-http",
        tools: result.tools.map((tool) => ({
          name: tool.name,
          description: tool.description ?? "",
          inputSchema: tool.inputSchema as JsonObject,
          outputSchema: (tool.outputSchema as JsonObject | undefined) ?? null,
        })),
      };
    });
  }

  async probe(endpoint: string, token: string | null, timeoutMs = 10_000): Promise<boolean> {
    await this.discover(endpoint, token, timeoutMs);
    return true;
  }

  async callTool(endpoint: string, token: string | null, name: string, arguments_: JsonObject, timeoutMs: number): Promise<ToolCallResult> {
    return this.withClient(endpoint, token, timeoutMs, async (client) => {
      const result = await client.callTool({ name, arguments: arguments_ }, undefined, { timeout: timeoutMs });
      return result as ToolCallResult;
    });
  }
}
