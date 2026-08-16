import { createHash, randomUUID } from "node:crypto";
import type { Pool, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type { AnalysisInputConsumer, SettledTurnInput } from "./input-consumer.js";
import type { AnalysisCall } from "./types.js";

export interface AnalysisOutboxWorkerOptions {
  batchSize: number;
  leaseMs: number;
  maxAttempts: number;
  retryBaseMs: number;
}

interface ClaimedEvent {
  id: number;
  eventId: string;
  turnId: string;
  settlementVersion: number;
  eventType: "upsert" | "retract";
  attemptCount: number;
}

interface TurnRow extends RowDataPacket {
  platform_owner_id: string;
  user_question: string | null;
  quality_status: string;
  execution_outcome: string;
  behavior_signals: unknown;
  first_event_at: Date | string;
  settlement_revision: number;
}

interface CallRow extends RowDataPacket {
  project_id: string;
  project_key: string;
  service_version_id: string;
  tool_version_id: string;
  tool_name: string;
  module_key: string | null;
  arguments_summary: unknown;
  call_status: string;
  outcome: string;
}

class AnalysisOutboxError extends Error {
  constructor(readonly code: string) { super(code); }
}

const parseJson = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const toDate = (value: Date | string): Date => value instanceof Date ? value : new Date(value);

function operationOf(toolName: string): string {
  const value = toolName.toLocaleLowerCase();
  if (/(?:delete|remove|cancel|删除|移除|取消)/u.test(value)) return "delete";
  if (/(?:update|edit|modify|change|set|修改|更新|编辑|变更)/u.test(value)) return "update";
  if (/(?:create|add|insert|new|新增|创建|添加|新建)/u.test(value)) return "create";
  if (/(?:query|search|find|fetch|get|read|list|lookup|查询|查找|获取|读取|查看|检索)/u.test(value)) return "query";
  return "execute";
}

function behaviorSignalsOf(value: unknown, executionOutcome: string): Record<string, boolean | number | string> {
  const parsed = value === null ? {} : parseJson<unknown>(value);
  const signals: Record<string, boolean | number | string> = {};
  if (Array.isArray(parsed)) {
    for (const signal of parsed) if (typeof signal === "string" && signal) signals[signal] = true;
  } else if (parsed && typeof parsed === "object") {
    for (const [key, item] of Object.entries(parsed as Record<string, unknown>)) {
      if (["boolean", "number", "string"].includes(typeof item)) signals[key] = item as boolean | number | string;
    }
  }
  if (executionOutcome === "recovered_after_error") signals.retried = true;
  return signals;
}

function parameterKeysOf(value: unknown): string[] {
  const summary = value === null ? {} : parseJson<unknown>(value);
  if (!summary || typeof summary !== "object" || Array.isArray(summary)) return [];
  return Object.keys(summary as Record<string, unknown>).sort();
}

export class AnalysisOutboxWorker {
  private readonly workerId = `analysis-input-${randomUUID()}`;

  constructor(
    private readonly pool: Pool,
    private readonly consumer: AnalysisInputConsumer,
    private readonly options: AnalysisOutboxWorkerOptions,
    private readonly clock: () => Date = () => new Date(),
  ) {}

  async drainOnce(): Promise<{ claimed: number; delivered: number; skipped: number; failed: number; deadLettered: number }> {
    const events = await this.claim(this.clock());
    let delivered = 0; let skipped = 0; let failed = 0; let deadLettered = 0;
    for (const event of events) {
      try {
        const input = await this.loadInput(event);
        if (input) await this.consumer.accept(input); else skipped++;
        if (await this.markDelivered(event.id, this.clock())) delivered++;
      } catch (error) {
        const code = error instanceof AnalysisOutboxError ? error.code : "ANALYSIS_INPUT_WRITE_FAILED";
        const delay = Math.min(60_000, this.options.retryBaseMs * 2 ** Math.max(0, event.attemptCount - 1));
        const dead = event.attemptCount >= this.options.maxAttempts;
        if (await this.markFailed(event.id, new Date(this.clock().getTime() + delay), dead, code)) {
          failed++;
          if (dead) deadLettered++;
        }
      }
    }
    return { claimed: events.length, delivered, skipped, failed, deadLettered };
  }

  private async claim(now: Date): Promise<ClaimedEvent[]> {
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT id,event_id,turn_id,settlement_revision,event_type,delivery_attempts
        FROM mcp_analysis_outbox
        WHERE (delivery_status='pending' AND COALESCE(next_attempt_at,created_at)<=?)
           OR (delivery_status='processing' AND lease_until<=?)
        ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`, [now, now, this.options.batchSize]);
      const leaseUntil = new Date(now.getTime() + this.options.leaseMs);
      for (const row of rows) await connection.execute("UPDATE mcp_analysis_outbox SET delivery_status='processing',delivery_attempts=delivery_attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id=?", [this.workerId, leaseUntil, now, row.id]);
      await connection.commit();
      return rows.map((row) => ({ id:Number(row.id),eventId:String(row.event_id),turnId:String(row.turn_id),settlementVersion:Number(row.settlement_revision),eventType:row.event_type,attemptCount:Number(row.delivery_attempts)+1 }));
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }

  private async loadInput(event: ClaimedEvent): Promise<SettledTurnInput | null> {
    if (event.eventType !== "upsert") throw new AnalysisOutboxError("UNSUPPORTED_ANALYSIS_EVENT");
    const [turnRows] = await this.pool.query<TurnRow[]>(`SELECT t.platform_owner_id,t.user_question,t.quality_status,t.execution_outcome,t.behavior_signals,t.first_event_at,t.settlement_revision
      FROM mcp_analysis_outbox o JOIN mcp_turns t ON t.id=o.turn_id
      WHERE o.id=? AND o.delivery_status='processing' AND o.lease_owner=?`, [event.id, this.workerId]);
    const turn = turnRows[0];
    if (!turn) throw new AnalysisOutboxError("ANALYSIS_TURN_NOT_FOUND");
    const currentVersion = Number(turn.settlement_revision);
    if (currentVersion > event.settlementVersion) return null;
    if (currentVersion !== event.settlementVersion) throw new AnalysisOutboxError("ANALYSIS_REVISION_MISMATCH");
    if (!turn.user_question?.trim()) throw new AnalysisOutboxError("ANALYSIS_QUERY_MISSING");
    // module_key 解析：按调用所属项目当前生效版本的工具登记信息取值。未登记模块的工具返回 NULL，
    // 由 modulePathOf 统一按“模块归属未登记”处理，不回退到用 project_key 代替 Module（MCPSTAT-1-L3 §6.1）。
    const [callRows] = await this.pool.query<CallRow[]>(`SELECT e.project_id,e.project_key,e.service_version_id,e.tool_version_id,e.tool_name,t.module_key,e.arguments_summary,e.call_status,e.outcome
      FROM mcp_call_events e
      LEFT JOIN mcp_projects p ON p.id=e.project_id
      LEFT JOIN mcp_tool_versions t ON t.service_version_id=p.active_version_id AND t.original_name=e.tool_name
      WHERE e.turn_id=? ORDER BY e.started_at,e.ingress_order,e.event_id`, [event.turnId]);
    if (!callRows.length) throw new AnalysisOutboxError("ANALYSIS_CALLS_MISSING");
    const calls: AnalysisCall[] = callRows.map((call, index) => ({
      sequence:index+1,projectId:String(call.project_id),moduleId:call.module_key ?? undefined,toolName:String(call.tool_name),serviceVersionId:String(call.service_version_id),toolVersionId:String(call.tool_version_id),operation:operationOf(String(call.tool_name)),
      parameterKeys:parameterKeysOf(call.arguments_summary),outcome:call.outcome === "success" ? "success" : "error",
    }));
    const partial = callRows.some((call) => call.call_status === "partial");
    const recovered = turn.execution_outcome === "recovered_after_error";
    const success = turn.execution_outcome === "all_calls_succeeded" || recovered;
    return {
      eventId:event.eventId,turnId:event.turnId,settlementVersion:event.settlementVersion,
      actorHash:createHash("sha256").update(turn.platform_owner_id).digest("hex"),queryText:turn.user_question,
      calls,behaviorSignals:behaviorSignalsOf(turn.behavior_signals,turn.execution_outcome),
      settlementStatus:partial ? "partial" : success ? "success" : "failed",
      collectionTrust:["trusted","inferred"].includes(turn.quality_status) ? "trusted" : turn.quality_status === "missing" ? "missing" : "suspect",
      occurredAt:toDate(turn.first_event_at),
    };
  }

  private async markDelivered(id: number, at: Date): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>("UPDATE mcp_analysis_outbox SET delivery_status='delivered',delivered_at=?,lease_owner=NULL,lease_until=NULL,last_error_code=NULL,updated_at=? WHERE id=? AND delivery_status='processing' AND lease_owner=?", [at, at, id, this.workerId]);
    return result.affectedRows === 1;
  }

  private async markFailed(id: number, nextAttemptAt: Date, dead: boolean, code: string): Promise<boolean> {
    const [result] = await this.pool.execute<ResultSetHeader>("UPDATE mcp_analysis_outbox SET delivery_status=?,next_attempt_at=?,lease_owner=NULL,lease_until=NULL,last_error_code=?,updated_at=? WHERE id=? AND delivery_status='processing' AND lease_owner=?", [dead ? "dead_letter" : "pending", nextAttemptAt, code, this.clock(), id, this.workerId]);
    return result.affectedRows === 1;
  }
}
