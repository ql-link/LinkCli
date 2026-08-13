import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ErrorCode, ListToolsRequestSchema, McpError } from "@modelcontextprotocol/sdk/types.js";
import type { Request, Response } from "express";
import { Router } from "express";
import type { JsonObject } from "../domain.js";
import { AppError } from "../errors.js";
import { bearerToken, type CredentialService } from "./auth.js";
import type { CatalogService } from "./catalog.js";
import type { GatewayRouter } from "./router.js";

function toMcpError(error: unknown): McpError {
  if (error instanceof AppError) {
    const code = ["INVALID_INPUT", "COLLECTION_CONTEXT_INVALID", "NOT_FOUND"].includes(error.code) ? ErrorCode.InvalidParams : ErrorCode.InternalError;
    return new McpError(code, error.message, { appCode: error.code, status: error.status, ...error.details });
  }
  return new McpError(ErrorCode.InternalError, "Internal gateway error");
}

export function createGatewayRouter(credentials: CredentialService, catalog: CatalogService, gateway: GatewayRouter): Router {
  const router = Router();

  router.all("/", async (req: Request, res: Response) => {
    let server: Server | undefined; let transport: StreamableHTTPServerTransport | undefined;
    try {
      const credential = await credentials.authenticate(bearerToken(req.header("authorization")));
      const mcpSessionId = req.header("mcp-session-id"); const customSessionId = req.header("x-linkcli-session-id");
      const transportSessionId = mcpSessionId ?? customSessionId ?? null;
      const transportSessionSource = mcpSessionId ? "mcp" as const : customSessionId ? "custom" as const : "missing" as const;
      server = new Server({ name: "linkcli", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } }, instructions: "For exact MCP call statistics, the host should send _meta keys com.tolink.stats/conversation-id and com.tolink.stats/turn-id on every tools/call in the same user turn. The optional com.tolink.stats/turn-sequence is a non-negative integer. When host metadata is unavailable, pass the same __linkcli_user_question value on every tool call caused by one user input." });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await catalog.listTools() }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const meta = (request.params as { _meta?: Record<string, unknown> })._meta;
        try { return await gateway.call(request.params.name, (request.params.arguments ?? {}) as JsonObject, { platformOwnerId: credential.ownerId, credentialId: credential.id, transportSessionId, transportSessionSource, ...(meta ? { meta } : {}) }); }
        catch (error) { throw toMcpError(error); }
      });
      transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      if (!res.headersSent) {
        const appError = error instanceof AppError ? error : new AppError("DOWNSTREAM_PROTOCOL_ERROR", "MCP gateway request failed", 500);
        res.status(appError.status).json({ error: { code: appError.code, message: appError.message } });
      }
    } finally {
      await transport?.close().catch(() => undefined);
      await server?.close().catch(() => undefined);
    }
  });
  return router;
}
