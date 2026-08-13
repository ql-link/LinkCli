import { Router, type Request } from "express";
import { z } from "zod";
import type { StatisticsQuery, StatisticsService } from "./service.js";
import { paginate } from "../console/pagination.js";

const querySchema = z.object({ from: z.string().datetime().optional(), to: z.string().datetime().optional(), projectId: z.string().uuid().optional(), toolName: z.string().min(1).max(128).optional(), credentialId: z.string().uuid().optional(), attributionMethod: z.enum(["client_turn", "session_question", "credential_question", "unavailable"]).optional(), attributionQuality: z.enum(["trusted", "inferred", "suspicious", "missing", "partial"]).optional(), turnId: z.string().uuid().optional(), conversationId: z.string().min(1).max(128).optional(), clientTurnId: z.string().min(1).max(128).optional() });
const query = (req: Request): StatisticsQuery => { const { from, to, ...parsed } = querySchema.parse(req.query); return { ...parsed, ...(from ? { from: new Date(from) } : {}), ...(to ? { to: new Date(to) } : {}) }; };
const page = (req: Request) => ({ cursor: typeof req.query.cursor === "string" ? req.query.cursor : undefined, limit: Math.min(100, Math.max(1, Number(req.query.limit) || 20)) });

export function createStatisticsRouter(statistics: StatisticsService): Router {
  const router = Router();
  router.get("/summary", async (req, res, next) => { try { res.json({ data: await statistics.summary(req.consoleUser!, query(req)) }); } catch (error) { next(error); } });
  router.get("/tools", async (req, res, next) => { try { res.json({ data: await statistics.tools(req.consoleUser!, query(req)) }); } catch (error) { next(error); } });
  router.get("/turns", async (req, res, next) => { try { const rows = await statistics.turns(req.consoleUser!, query(req)); const result = paginate(rows, page(req).cursor, page(req).limit, (row) => row.id); res.json({ data: result.data, meta: { nextCursor: result.nextCursor } }); } catch (error) { next(error); } });
  router.get("/calls", async (req, res, next) => { try { const rows = await statistics.calls(req.consoleUser!, query(req)); const result = paginate(rows, page(req).cursor, page(req).limit, (row) => row.id); res.json({ data: result.data, meta: { nextCursor: result.nextCursor } }); } catch (error) { next(error); } });
  router.get("/turns/:id", async (req, res, next) => { try { res.json({ data: await statistics.turn(req.consoleUser!, String(req.params.id)) }); } catch (error) { next(error); } });
  router.get("/turns/:id/calls", async (req, res, next) => { try { res.json({ data: (await statistics.turn(req.consoleUser!, String(req.params.id))).calls }); } catch (error) { next(error); } });
  router.post("/dead-letters/:id/replay", async (req, res, next) => { try { await statistics.replayDeadLetter(req.consoleUser!, String(req.params.id)); res.status(202).json({ data: { eventId: String(req.params.id), status: "ready" } }); } catch (error) { next(error); } });
  return router;
}
