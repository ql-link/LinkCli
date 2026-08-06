import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { ZodError } from "zod";
import { createAdminRouter, type AdminServices } from "./admin/http.js";
import { AppError } from "./errors.js";
import type { CredentialService } from "./gateway/auth.js";
import type { CatalogService } from "./gateway/catalog.js";
import type { GatewayRouter } from "./gateway/router.js";
import { createGatewayRouter } from "./gateway/server.js";

export interface ApplicationServices extends AdminServices { catalog: CatalogService; gateway: GatewayRouter; credentials: CredentialService; }

export function createApp(services: ApplicationServices, adminApiKey: string, host = "127.0.0.1", allowedHosts?: string[]) {
  const app = createMcpExpressApp({ host, ...(allowedHosts?.length ? { allowedHosts } : {}) });
  app.use(express.json({ limit: "1mb" }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  app.use("/admin", createAdminRouter(services, adminApiKey));
  app.use("/mcp", createGatewayRouter(services.credentials, services.catalog, services.gateway));
  app.use((_req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found" } }));
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Request validation failed", details: error.flatten() } });
    if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details } });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error" } });
  });
  return app;
}
