import { timingSafeEqual } from "node:crypto";
import { Router, type NextFunction, type Request, type Response } from "express";
import { z } from "zod";
import type { PlatformIdentity, ServiceVersion } from "../domain.js";
import { AppError } from "../errors.js";
import type { CredentialService } from "../gateway/auth.js";
import type { HealthMonitor } from "../registry/health-monitor.js";
import type { ProjectService } from "../registry/project-service.js";
import type { ReviewService } from "../registry/review-service.js";
import type { CollectionRepository } from "../collection/repository.js";

const projectSchema = z.object({ projectKey: z.string(), displayName: z.string(), description: z.string(), endpoint: z.string(), projectToken: z.string().min(1).optional() });
const versionSchema = z.object({ endpoint: z.string(), projectToken: z.string().min(1).optional() });
const reviewSchema = z.object({ decision: z.enum(["approved", "rejected"]), comment: z.string().optional() });
const statusSchema = z.object({ action: z.enum(["disable", "enable", "retire"]) });
const bypassSchema = z.object({ enabled: z.boolean() });
const credentialSchema = z.object({ credentialName: z.string(), expiresAt: z.string().datetime().nullable().optional() });

declare global { namespace Express { interface Request { platformIdentity?: PlatformIdentity; } } }

function constantEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual); const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function versionView(version: ServiceVersion): Record<string, unknown> {
  const { credentialCiphertext: _secret, definitionHash, ...safe } = version;
  return { ...safe, definitionHash: definitionHash.toString("hex") };
}

function credentialView<T extends { tokenDigest: Buffer }>(credential: T): Omit<T, "tokenDigest"> {
  const { tokenDigest: _digest, ...safe } = credential;
  return safe;
}

function identity(req: Request): PlatformIdentity {
  const userId = req.header("x-platform-user-id")?.trim();
  const role = req.header("x-platform-role")?.trim();
  if (!userId || !["owner", "reviewer", "operator", "platform_user"].includes(role ?? "")) throw new AppError("AUTHENTICATION_FAILED", "Platform identity headers are required", 401);
  return { userId, role: role as PlatformIdentity["role"] };
}

const requireRole = (allowed: PlatformIdentity["role"][]) => (req: Request, _res: Response, next: NextFunction): void => {
  try {
    const current = identity(req);
    if (!allowed.includes(current.role)) throw new AppError("AUTHORIZATION_FAILED", "Platform role is not allowed", 403);
    req.platformIdentity = current;
    next();
  } catch (error) { next(error); }
};

export interface AdminServices { projects: ProjectService; reviews: ReviewService; health: HealthMonitor; credentials: CredentialService; collection?: CollectionRepository; }

export function createAdminRouter(services: AdminServices, adminApiKey: string): Router {
  const router = Router();
  router.use((req, _res, next) => {
    const provided = req.header("x-admin-api-key") ?? "";
    if (!constantEqual(provided, adminApiKey)) return next(new AppError("AUTHENTICATION_FAILED", "Admin API key is invalid", 401));
    next();
  });

  router.post("/projects", requireRole(["owner"]), async (req, res) => {
    const body = projectSchema.parse(req.body); const actor = req.platformIdentity!;
    const created = await services.projects.register({ ...body, ownerId: actor.userId });
    res.status(201).json({ project: created.project, version: versionView(created.version), tools: created.tools });
  });
  router.post("/projects/:key/versions", requireRole(["owner"]), async (req, res) => {
    const body = versionSchema.parse(req.body); const created = await services.projects.createVersion({ projectKey: String(req.params.key), ...body, submittedBy: req.platformIdentity!.userId });
    res.status(201).json({ version: versionView(created.version), tools: created.tools, suspendedTools: created.suspendedTools });
  });
  router.patch("/projects/:key/trusted-review-bypass", requireRole(["operator"]), async (req, res) => {
    const body = bypassSchema.parse(req.body); res.json(await services.projects.setTrustedBypass(String(req.params.key), body.enabled));
  });
  router.post("/versions/:id/submit", requireRole(["owner"]), async (req, res) => {
    res.json(versionView(await services.reviews.submit(String(req.params.id), req.platformIdentity!.userId)));
  });
  router.post("/versions/:id/review", requireRole(["reviewer"]), async (req, res) => {
    const body = reviewSchema.parse(req.body); const result = await services.reviews.decide(String(req.params.id), body.decision, req.platformIdentity!.userId, body.comment);
    res.json({ ...result, version: versionView(result.version) });
  });
  router.patch("/projects/:key/status", requireRole(["owner", "operator"]), async (req, res) => {
    const body = statusSchema.parse(req.body); const actor = req.platformIdentity!;
    res.json(await services.health.changeProjectStatus(String(req.params.key), body.action, actor.userId, actor.role === "operator"));
  });
  router.post("/credentials", requireRole(["platform_user", "owner", "reviewer", "operator"]), async (req, res) => {
    const body = credentialSchema.parse(req.body); const result = await services.credentials.issue(req.platformIdentity!.userId, body.credentialName, body.expiresAt ? new Date(body.expiresAt) : null);
    res.status(201).json({ credential: credentialView(result.credential), token: result.token });
  });
  router.get("/credentials", requireRole(["platform_user", "owner", "reviewer", "operator"]), async (req, res) => { res.json(await services.credentials.list(req.platformIdentity!.userId)); });
  router.delete("/credentials/:id", requireRole(["platform_user", "owner", "reviewer", "operator"]), async (req, res) => { res.json(credentialView(await services.credentials.revoke(String(req.params.id), req.platformIdentity!.userId))); });
  if (services.collection) router.post("/collection/dead-letters/:id/replay", requireRole(["operator"]), async (req, res) => {
    const id = String(req.params.id); const replayed = await services.collection!.replayDeadLetter(id, new Date());
    if (!replayed) throw new AppError("NOT_FOUND", "Dead-letter event not found", 404);
    res.status(202).json({ eventId: id, deliveryStatus: "ready" });
  });
  return router;
}
