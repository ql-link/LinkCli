import { randomUUID } from "node:crypto";
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
    const code = error.code === "INVALID_INPUT" ? ErrorCode.InvalidParams : error.code === "NOT_FOUND" ? ErrorCode.InvalidParams : ErrorCode.InternalError;
    return new McpError(code, error.message, { appCode: error.code, status: error.status, ...error.details });
  }
  return new McpError(ErrorCode.InternalError, "Internal gateway error");
}

export function createGatewayRouter(credentials: CredentialService, catalog: CatalogService, gateway: GatewayRouter): Router {
  const router = Router();
  const sequences = new Map<string, number>();

  router.all("/", async (req: Request, res: Response) => {
    let server: Server | undefined; let transport: StreamableHTTPServerTransport | undefined;
    try {
      const credential = await credentials.authenticate(bearerToken(req.header("authorization")));
      const sessionId = req.header("mcp-session-id") ?? req.header("x-linkcli-session-id") ?? `stateless:${credential.id}`;
      server = new Server({ name: "linkcli", version: "0.1.0" }, { capabilities: { tools: { listChanged: true } } });
      server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: await catalog.listTools() }));
      server.setRequestHandler(CallToolRequestSchema, async (request) => {
        const sequenceKey = `${credential.id}\0${sessionId}`; const callSequence = (sequences.get(sequenceKey) ?? 0) + 1; sequences.set(sequenceKey, callSequence);
        try { return await gateway.call(request.params.name, (request.params.arguments ?? {}) as JsonObject, { platformOwnerId: credential.ownerId, sessionId, callSequence }); }
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
