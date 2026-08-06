import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextFunction, Request, Response } from "express";
import express from "express";
import { ZodError } from "zod";
import { createAdminRouter, type AdminServices } from "./admin/http.js";
import { createConsoleRouter, type ConsoleServices } from "./console/http.js";
import { AppError } from "./errors.js";
import type { CredentialService } from "./gateway/auth.js";
import type { CatalogService } from "./gateway/catalog.js";
import type { GatewayRouter } from "./gateway/router.js";
import { createGatewayRouter } from "./gateway/server.js";

export interface ApplicationServices extends AdminServices { catalog: CatalogService; gateway: GatewayRouter; credentials: CredentialService; }
declare global { namespace Express { interface Request { requestId?: string; } } }

export function createApp(services: ApplicationServices, adminApiKey: string, host = "127.0.0.1", allowedHosts?: string[], consoleServices?: ConsoleServices, webDistDir?: string, secureCookie = false) {
  const app = createMcpExpressApp({ host, ...(allowedHosts?.length ? { allowedHosts } : {}) });
  app.use((req, res, next) => { req.requestId = randomUUID(); res.setHeader("x-request-id", req.requestId); next(); });
  app.use(express.json({ limit: "1mb" }));
  app.get("/healthz", (_req, res) => res.json({ status: "ok" }));
  if (consoleServices) {
    app.use("/api", createConsoleRouter(consoleServices, secureCookie));
    app.use("/api", (req, res) => res.status(404).json({ error: { code:"NOT_FOUND", message:"API route not found", requestId:req.requestId } }));
  }
  app.use("/admin", createAdminRouter(services, adminApiKey));
  app.use("/mcp", createGatewayRouter(services.credentials, services.catalog, services.gateway));
  if (webDistDir) {
    const directory = resolve(webDistDir); const index = resolve(directory, "index.html");
    if (existsSync(index)) {
      app.use(express.static(directory));
      app.use((req, res, next) => { if (req.method === "GET" && req.accepts("html")) return res.sendFile(index); next(); });
    }
  }
  app.use((req, res) => res.status(404).json({ error: { code: "NOT_FOUND", message: "Route not found", requestId:req.requestId } }));
  app.use((error: unknown, req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ZodError) return res.status(400).json({ error: { code: "INVALID_INPUT", message: "Request validation failed", details: error.flatten(), requestId:req.requestId } });
    if (error instanceof AppError) return res.status(error.status).json({ error: { code: error.code, message: error.message, details: error.details, requestId:req.requestId } });
    res.status(500).json({ error: { code: "INTERNAL_ERROR", message: "Internal server error", requestId:req.requestId } });
  });
  return app;
}
