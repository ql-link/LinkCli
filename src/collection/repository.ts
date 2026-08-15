import { createHash, randomUUID } from "node:crypto";
import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { CallEvent, CallOutboxRecord, ConversationTurn, JsonObject } from "../domain.js";
import { createCandidateTurnKey, createExactTurnKey } from "./context.js";

export interface CollectionSettings {
  idleTimeoutMs: number;
  gracePeriodMs: number;
  lateRevisionMs: number;
  maxCallsPerTurn: number;
  maxDeliveryAttempts: number;
}

export interface BeginCallInput {
  id: string;
  platformOwnerId: string;
  credentialId: string;
  projectId: string;
  serviceVersionId: string;
  toolVersionId: string;
  projectKey: string;
  toolName: string;
  argumentsSummary: JsonObject;
  attribution: CallOutboxRecord["attribution"];
  startedAt: Date;
  skillId?: string;
  skillVersionId?: string;
  skillRunId?: string;
  skillStepId?: string;
}

export interface CompleteCallInput {
  resultSummary: JsonObject;
  outcome: "success" | "error";
  errorCode: string | null;
  completedAt: Date;
  durationMs: number;
}

export interface StatisticsFilter {
  projectIds?: string[];
  projectKeys?: string[];
  conversationId?: string;
  clientTurnId?: string;
  from?: Date;
  to?: Date;
}

export interface AnalysisOutboxRecord {
  eventId: string;
  turnId: string;
  settlementRevision: number;
  payload: JsonObject;
}

export interface CollectionRepository {
  beginCall(input: BeginCallInput): Promise<CallOutboxRecord>;
  completeCall(eventId: string, input: CompleteCallInput): Promise<void>;
  markCallPartial(eventId: string, errorCode: string, at: Date): Promise<void>;
  reconcileStarted(before: Date): Promise<number>;
  claimReady(workerId: string, now: Date, leaseMs: number, limit: number): Promise<CallOutboxRecord[]>;
  markDelivered(eventId: string, workerId: string, at: Date): Promise<boolean>;
  markDeliveryFailure(eventId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number): Promise<boolean>;
  ingestCall(record: CallOutboxRecord, settings: CollectionSettings, now: Date): Promise<CallEvent>;
  advanceTurnLifecycles(settings: CollectionSettings, now: Date): Promise<number>;
  settleReadyTurns(now: Date, limit: number): Promise<number>;
  purgeExpired(detailBefore: Date, outboxBefore: Date): Promise<{ callEvents: number; outbox: number }>;
  replayDeadLetter(eventId: string, at: Date): Promise<boolean>;
  listOutbox(): Promise<CallOutboxRecord[]>;
  listTurns(filter?: StatisticsFilter): Promise<ConversationTurn[]>;
  getTurn(turnId: string): Promise<ConversationTurn | null>;
  listCallEvents(filter?: StatisticsFilter & { turnId?: string }): Promise<CallEvent[]>;
  listAnalysisOutbox(): Promise<AnalysisOutboxRecord[]>;
}

function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map(clone) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

const bufferKey = (value: Buffer | null): string | null => value?.toString("hex") ?? null;
const between = (value: Date, filter?: StatisticsFilter): boolean => (!filter?.from || value >= filter.from) && (!filter?.to || value < filter.to);
const includesProject = (projectId: string, filter?: StatisticsFilter): boolean => !filter?.projectIds || filter.projectIds.includes(projectId);

export class MemoryCollectionRepository implements CollectionRepository {
  private sequence = 0;
  private readonly outbox = new Map<string, CallOutboxRecord>();
  private readonly turns = new Map<string, ConversationTurn>();
  private readonly events = new Map<string, CallEvent>();
  private readonly analysisOutbox = new Map<string, AnalysisOutboxRecord>();

  async beginCall(input: BeginCallInput): Promise<CallOutboxRecord> {
    if (this.outbox.has(input.id)) throw new Error(`Duplicate collection event: ${input.id}`);
    const now = new Date(input.startedAt);
    const record: CallOutboxRecord = {
      ...clone(input), ingressSequence: ++this.sequence, resultSummary: null, status: "started", outcome: "unknown", errorCode: null,
      completedAt: null, durationMs: null, deliveryStatus: "waiting", deliveryAttempts: 0, nextAttemptAt: now,
      leaseOwner: null, leaseExpiresAt: null, deliveredAt: null, createdAt: now, updatedAt: now,
    };
    this.outbox.set(record.id, record);
    return clone(record);
  }

  async completeCall(eventId: string, input: CompleteCallInput): Promise<void> {
    const record = this.outbox.get(eventId);
    if (!record) throw new Error(`Collection event not found: ${eventId}`);
    Object.assign(record, clone(input), { status: "completed", deliveryStatus: "ready", updatedAt: new Date(input.completedAt) });
  }

  async markCallPartial(eventId: string, errorCode: string, at: Date): Promise<void> {
    const record = this.outbox.get(eventId);
    if (!record || record.status !== "started") return;
    Object.assign(record, { status: "partial", outcome: "unknown", errorCode, completedAt: new Date(at), durationMs: Math.max(0, at.getTime() - record.startedAt.getTime()), deliveryStatus: "ready", updatedAt: new Date(at) });
  }

  async reconcileStarted(before: Date): Promise<number> {
    let count = 0;
    for (const record of this.outbox.values()) {
      if (record.status === "started" && record.startedAt < before) {
        await this.markCallPartial(record.id, "COLLECTION_COMPLETION_MISSING", before); count++;
      }
    }
    return count;
  }

  async claimReady(workerId: string, now: Date, leaseMs: number, limit: number): Promise<CallOutboxRecord[]> {
    const records = [...this.outbox.values()]
      .filter((record) => record.status !== "started" && record.nextAttemptAt <= now && (record.deliveryStatus === "ready" || (record.deliveryStatus === "processing" && (!record.leaseExpiresAt || record.leaseExpiresAt <= now))))
      .sort((left, right) => left.ingressSequence - right.ingressSequence).slice(0, limit);
    for (const record of records) {
      record.deliveryStatus = "processing"; record.leaseOwner = workerId; record.leaseExpiresAt = new Date(now.getTime() + leaseMs); record.deliveryAttempts++; record.updatedAt = new Date(now);
    }
    return clone(records);
  }

  async markDelivered(eventId: string, workerId: string, at: Date): Promise<boolean> {
    const record = this.outbox.get(eventId); if (!record) return false;
    if (record.deliveryStatus !== "processing" || record.leaseOwner !== workerId) return false;
    Object.assign(record, { deliveryStatus: "delivered", deliveredAt: new Date(at), leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date(at) });
    return true;
  }

  async markDeliveryFailure(eventId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number): Promise<boolean> {
    const record = this.outbox.get(eventId); if (!record) return false;
    if (record.deliveryStatus !== "processing" || record.leaseOwner !== workerId) return false;
    Object.assign(record, { deliveryStatus: record.deliveryAttempts >= maxAttempts ? "dead_letter" : "ready", nextAttemptAt: new Date(nextAttemptAt), leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date() });
    return true;
  }

  async ingestCall(record: CallOutboxRecord, settings: CollectionSettings, now: Date): Promise<CallEvent> {
    const existing = this.events.get(record.id); if (existing) return clone(existing);
    let turn: ConversationTurn | undefined;
    const exactKey = bufferKey(record.attribution.exactTurnKey);
    const candidateKey = bufferKey(record.attribution.candidateTurnKey);
    if (exactKey) turn = [...this.turns.values()].find((item) => bufferKey(item.exactTurnKey) === exactKey);
    if (!turn && candidateKey) {
      turn = [...this.turns.values()].filter((item) => bufferKey(item.candidateTurnKey) === candidateKey && ["collecting", "grace"].includes(item.lifecycleStatus)
        && item.callCount < settings.maxCallsPerTurn
        && record.startedAt.getTime() >= item.firstEventAt.getTime() - settings.idleTimeoutMs && record.startedAt.getTime() <= item.lastEventAt.getTime() + settings.idleTimeoutMs)
        .sort((left, right) => right.lastEventAt.getTime() - left.lastEventAt.getTime())[0];
    }
    if (!turn && record.attribution.method !== "unavailable") {
      turn = {
        id: randomUUID(), platformOwnerId: record.platformOwnerId, credentialId: record.credentialId,
        conversationId: record.attribution.conversationId, clientTurnId: record.attribution.clientTurnId, clientTurnSequence: record.attribution.clientTurnSequence,
        exactTurnKey: clone(record.attribution.exactTurnKey), candidateTurnKey: clone(record.attribution.candidateTurnKey),
        attributionMethod: record.attribution.method, attributionQuality: record.status === "partial" ? "partial" : record.attribution.quality, userQuestion: record.attribution.userQuestion, questionFingerprint: clone(record.attribution.questionFingerprint), lifecycleStatus: "collecting", settlementStatus: "pending",
        callCount: 0, successCount: 0, errorCount: 0, partialCount: 0, firstEventAt: new Date(record.startedAt), lastEventAt: new Date(record.startedAt),
        graceUntil: null, finalizedAt: null, revision: 0, settledRevision: 0, canonicalChain: null, createdAt: new Date(now), updatedAt: new Date(now),
      };
      this.turns.set(turn.id, turn);
    }
    if (turn) {
      if (turn.lifecycleStatus === "finalized" && exactKey && (!turn.finalizedAt || now.getTime() - turn.finalizedAt.getTime() > settings.lateRevisionMs)) throw new Error("Late revision window expired");
      const isLateExactRevision = turn.lifecycleStatus === "finalized" && exactKey && turn.finalizedAt && now.getTime() - turn.finalizedAt.getTime() <= settings.lateRevisionMs;
      if (isLateExactRevision) { turn.revision++; turn.settlementStatus = "pending"; }
      else if (turn.lifecycleStatus === "grace") { turn.lifecycleStatus = "collecting"; turn.graceUntil = null; }
      turn.callCount++;
      if (record.status === "partial") turn.partialCount++;
      else if (record.outcome === "success") turn.successCount++;
      else if (record.outcome === "error") turn.errorCount++;
      turn.firstEventAt = turn.firstEventAt < record.startedAt ? turn.firstEventAt : new Date(record.startedAt);
      turn.lastEventAt = turn.lastEventAt > record.startedAt ? turn.lastEventAt : new Date(record.startedAt);
      if (record.status === "partial") turn.attributionQuality = "partial";
      else if (turn.attributionQuality !== "partial" && turn.attributionQuality !== "suspicious" && record.attribution.quality === "suspicious") turn.attributionQuality = "suspicious";
      turn.updatedAt = new Date(now);
    }
    const event: CallEvent = {
      id: record.id, turnId: turn?.id ?? null, ingressSequence: record.ingressSequence, platformOwnerId: record.platformOwnerId, credentialId: record.credentialId,
      projectId: record.projectId, serviceVersionId: record.serviceVersionId, toolVersionId: record.toolVersionId, projectKey: record.projectKey, toolName: record.toolName, userQuestion: record.attribution.userQuestion,
      attributionMethod: record.attribution.method, attributionQuality: record.attribution.quality, qualitySignals: clone(record.attribution.qualitySignals),
      argumentsSummary: clone(record.argumentsSummary), resultSummary: clone(record.resultSummary), status: record.status, outcome: record.outcome, errorCode: record.errorCode,
      startedAt: new Date(record.startedAt), completedAt: clone(record.completedAt), durationMs: record.durationMs, createdAt: new Date(now),
      skillId: record.skillId, skillVersionId: record.skillVersionId, skillRunId: record.skillRunId, skillStepId: record.skillStepId,
    };
    this.events.set(event.id, event);
    return clone(event);
  }

  async advanceTurnLifecycles(settings: CollectionSettings, now: Date): Promise<number> {
    let count = 0;
    for (const turn of this.turns.values()) {
      if (turn.lifecycleStatus === "collecting" && (turn.callCount >= settings.maxCallsPerTurn || now.getTime() - Math.max(turn.lastEventAt.getTime(), turn.updatedAt.getTime()) >= settings.idleTimeoutMs)) {
        turn.lifecycleStatus = "grace"; turn.graceUntil = new Date(now.getTime() + settings.gracePeriodMs); turn.updatedAt = new Date(now); count++;
      } else if (turn.lifecycleStatus === "grace" && turn.graceUntil && turn.graceUntil <= now) {
        turn.lifecycleStatus = "finalized"; turn.finalizedAt = new Date(now); turn.settlementStatus = "pending"; if (turn.revision === 0) turn.revision = 1; turn.updatedAt = new Date(now); count++;
      }
    }
    return count;
  }

  async settleReadyTurns(now: Date, limit: number): Promise<number> {
    const ready = [...this.turns.values()].filter((turn) => turn.lifecycleStatus === "finalized" && (turn.settlementStatus !== "succeeded" || turn.settledRevision < turn.revision)).slice(0, limit);
    for (const turn of ready) {
      const ordered = [...this.events.values()].filter((event) => event.turnId === turn.id).sort(compareEvents);
      turn.canonicalChain = { calls: canonicalCalls(ordered) };
      turn.settlementStatus = "succeeded"; turn.settledRevision = turn.revision; turn.updatedAt = new Date(now);
      if (["trusted", "inferred"].includes(turn.attributionQuality)) {
        const key = `${turn.id}:${turn.revision}:upsert`;
        if (!this.analysisOutbox.has(key)) this.analysisOutbox.set(key, { eventId: randomUUID(), turnId: turn.id, settlementRevision: turn.revision, payload: { turnId: turn.id, revision: turn.revision, attributionMethod: turn.attributionMethod, attributionQuality: turn.attributionQuality, callCount: ordered.length, canonicalChain: clone(turn.canonicalChain) } });
      }
    }
    return ready.length;
  }

  async purgeExpired(detailBefore: Date, outboxBefore: Date): Promise<{ callEvents: number; outbox: number }> {
    let callEvents = 0; let outbox = 0;
    for (const [id, event] of this.events) if (event.startedAt < detailBefore) { this.events.delete(id); callEvents++; }
    for (const turn of this.turns.values()) if (turn.lastEventAt < detailBefore) { turn.userQuestion = null; turn.questionFingerprint = null; }
    for (const [id, record] of this.outbox) if ((record.updatedAt < outboxBefore && record.deliveryStatus === "delivered") || (record.updatedAt < detailBefore && record.deliveryStatus === "dead_letter")) { this.outbox.delete(id); outbox++; }
    return { callEvents, outbox };
  }

  async replayDeadLetter(eventId: string, at: Date): Promise<boolean> {
    const record = this.outbox.get(eventId); if (!record || record.deliveryStatus !== "dead_letter") return false;
    Object.assign(record, { deliveryStatus: "ready", deliveryAttempts: 0, nextAttemptAt: new Date(at), leaseOwner: null, leaseExpiresAt: null, updatedAt: new Date(at) }); return true;
  }

  async listOutbox(): Promise<CallOutboxRecord[]> { return clone([...this.outbox.values()].sort((a, b) => a.ingressSequence - b.ingressSequence)); }
  async listTurns(filter?: StatisticsFilter): Promise<ConversationTurn[]> {
    const allowedTurnIds = filter?.projectIds ? new Set([...this.events.values()].filter((event) => includesProject(event.projectId, filter)).map((event) => event.turnId)) : null;
    return clone([...this.turns.values()].filter((turn) => {
      const archivedProjectVisible = Boolean(filter?.projectKeys?.length && ((turn.canonicalChain?.calls as Array<{ projectKey?: string }> | undefined) ?? []).some((call) => call.projectKey && filter.projectKeys!.includes(call.projectKey)));
      return between(turn.firstEventAt, filter) && (!filter?.conversationId || turn.conversationId === filter.conversationId) && (!filter?.clientTurnId || turn.clientTurnId === filter.clientTurnId) && (!allowedTurnIds || allowedTurnIds.has(turn.id) || archivedProjectVisible);
    }).sort((a, b) => b.firstEventAt.getTime() - a.firstEventAt.getTime()));
  }
  async getTurn(turnId: string): Promise<ConversationTurn | null> { return clone(this.turns.get(turnId) ?? null); }
  async listCallEvents(filter?: StatisticsFilter & { turnId?: string }): Promise<CallEvent[]> {
    return clone([...this.events.values()].filter((event) => {
      const turn = event.turnId ? this.turns.get(event.turnId) : null;
      return (!filter?.turnId || event.turnId === filter.turnId) && (!filter?.conversationId || turn?.conversationId === filter.conversationId) && (!filter?.clientTurnId || turn?.clientTurnId === filter.clientTurnId) && includesProject(event.projectId, filter) && between(event.startedAt, filter);
    }).sort(compareEvents));
  }
  async listAnalysisOutbox(): Promise<AnalysisOutboxRecord[]> { return clone([...this.analysisOutbox.values()]); }
}

function compareEvents(left: CallEvent, right: CallEvent): number {
  return left.startedAt.getTime() - right.startedAt.getTime() || left.ingressSequence - right.ingressSequence || left.id.localeCompare(right.id);
}

function canonicalCalls(events: CallEvent[]): Array<Record<string, unknown>> {
  const groups: Array<number | null> = Array.from({ length: events.length }, () => null);
  let component: number[] = [];
  let componentEnd = Number.NEGATIVE_INFINITY;
  let nextGroup = 1;
  const flush = (): void => {
    if (component.length > 1) { const group = nextGroup++; for (const index of component) groups[index] = group; }
    component = [];
    componentEnd = Number.NEGATIVE_INFINITY;
  };
  events.forEach((event, index) => {
    const start = event.startedAt.getTime(); const end = event.completedAt?.getTime() ?? start;
    if (component.length && start >= componentEnd) flush();
    component.push(index); componentEnd = Math.max(componentEnd, end);
  });
  flush();
  return events.map((event, index) => ({ sequence: index + 1, parallelGroup: groups[index], eventId: event.id, projectKey: event.projectKey, toolName: event.toolName, outcome: event.outcome, status: event.status, errorCode: event.errorCode, startedAt: event.startedAt.toISOString(), completedAt: event.completedAt?.toISOString() ?? null, durationMs: event.durationMs }));
}

type Executor = Pool | PoolConnection;
const toDate = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const nullableDate = (value: unknown): Date | null => value === null ? null : toDate(value);
const parseJson = <T>(value: unknown): T => (typeof value === "string" ? JSON.parse(value) : value) as T;

function outboxFrom(row: RowDataPacket, fingerprintKey: Buffer): CallOutboxRecord {
  const method = row.attribution_hint === "missing" ? "unavailable" : row.attribution_hint;
  const signals = parseJson<string[]>(row.validation_signals);
  const questionFingerprint = row.question_fingerprint === null ? null : Buffer.from(row.question_fingerprint);
  const exactTurnKey = method === "client_turn" && row.client_conversation_id && row.client_turn_id ? createExactTurnKey(fingerprintKey, row.credential_id, row.client_conversation_id, row.client_turn_id) : null;
  const candidateTurnKey = exactTurnKey ?? (questionFingerprint ? createCandidateTurnKey(fingerprintKey, row.credential_id, row.transport_session_id, questionFingerprint) : null);
  const quality = row.call_status === "partial" ? "partial" : method === "unavailable" ? "missing" : signals.length ? "suspicious" : method === "client_turn" ? "trusted" : "inferred";
  const resultSummary = row.result_summary === null ? null : parseJson<JsonObject>(row.result_summary);
  const errorCode = row.call_error_code ?? null;
  return {
    id: row.event_id, ingressSequence: Number(row.id), platformOwnerId: row.platform_owner_id, credentialId: row.credential_id,
    projectId: row.project_id, serviceVersionId: row.service_version_id, toolVersionId: row.tool_version_id, projectKey: row.project_key, toolName: row.tool_name, argumentsSummary: parseJson(row.arguments_summary),
    resultSummary,
    attribution: { method, quality, qualitySignals: signals, conversationId: row.client_conversation_id, clientTurnId: row.client_turn_id,
      clientTurnSequence: row.client_turn_sequence === null ? null : Number(row.client_turn_sequence), transportSessionId: row.transport_session_id,
      transportSessionSource: row.session_source, userQuestion: row.user_question, questionFingerprint, exactTurnKey, candidateTurnKey },
    status: row.call_status, outcome: row.outcome, errorCode, startedAt: toDate(row.started_at), completedAt: nullableDate(row.completed_at),
    durationMs: row.duration_ms === null ? null : Number(row.duration_ms), deliveryStatus: row.delivery_status, deliveryAttempts: Number(row.delivery_attempts),
    nextAttemptAt: row.next_attempt_at === null ? toDate(row.started_at) : toDate(row.next_attempt_at), leaseOwner: row.lease_owner, leaseExpiresAt: nullableDate(row.lease_until), deliveredAt: nullableDate(row.delivered_at),
    createdAt: toDate(row.created_at), updatedAt: toDate(row.updated_at),
    skillId: row.skill_id ?? undefined, skillVersionId: row.skill_version_id ?? undefined, skillRunId: row.skill_run_id ?? undefined, skillStepId: row.skill_step_id ?? undefined,
  };
}

function turnFrom(row: RowDataPacket): ConversationTurn {
  const revision = Number(row.settlement_revision); const callCount = Number(row.call_count); const errorCount = Number(row.error_count);
  return { id: row.id, platformOwnerId: row.platform_owner_id, credentialId: row.credential_id, conversationId: row.client_conversation_id, clientTurnId: row.client_turn_id,
    clientTurnSequence: row.client_turn_sequence === null ? null : Number(row.client_turn_sequence), exactTurnKey: row.exact_turn_key === null ? null : Buffer.from(row.exact_turn_key), candidateTurnKey: Buffer.from(row.candidate_key),
    attributionMethod: row.attribution_method, attributionQuality: row.quality_status, userQuestion: row.user_question, questionFingerprint: row.question_fingerprint === null ? null : Buffer.from(row.question_fingerprint),
    lifecycleStatus: row.lifecycle_status, settlementStatus: row.settlement_status, callCount, successCount: Math.max(0, callCount - errorCount), errorCount,
    partialCount: row.quality_status === "partial" ? 1 : 0, firstEventAt: toDate(row.first_event_at), lastEventAt: toDate(row.last_event_at), graceUntil: nullableDate(row.grace_until),
    finalizedAt: nullableDate(row.finalized_at), revision, settledRevision: row.settlement_status === "succeeded" ? revision : Math.max(0, revision - 1), canonicalChain: row.canonical_chain === null ? null : parseJson(row.canonical_chain),
    createdAt: toDate(row.created_at), updatedAt: toDate(row.updated_at) };
}

function eventFrom(row: RowDataPacket): CallEvent {
  const resultSummary = row.result_summary === null ? null : parseJson<JsonObject>(row.result_summary);
  return { id: row.event_id, turnId: row.turn_id, ingressSequence: Number(row.ingress_order), platformOwnerId: row.platform_owner_id, credentialId: row.credential_id,
    projectId: row.project_id, serviceVersionId: row.service_version_id, toolVersionId: row.tool_version_id, projectKey: row.project_key, toolName: row.tool_name, userQuestion: row.user_question, attributionMethod: row.attribution_method === "missing" ? "unavailable" : row.attribution_method,
    attributionQuality: row.attribution_quality, qualitySignals: parseJson(row.validation_signals), argumentsSummary: parseJson(row.arguments_summary),
    resultSummary, status: row.call_status, outcome: row.outcome, errorCode: row.call_error_code ?? null,
    startedAt: toDate(row.started_at), completedAt: nullableDate(row.completed_at), durationMs: row.duration_ms === null ? null : Number(row.duration_ms), createdAt: toDate(row.received_at),
    skillId: row.skill_id ?? undefined, skillVersionId: row.skill_version_id ?? undefined, skillRunId: row.skill_run_id ?? undefined, skillStepId: row.skill_step_id ?? undefined };
}

const eventSelect = `SELECT e.*, COALESCE(o.platform_owner_id, t.platform_owner_id, '') AS platform_owner_id,
  COALESCE(o.attribution_hint, t.attribution_method, 'missing') AS attribution_method,
  e.call_status, e.call_error_code, COALESCE(t.quality_status, 'missing') AS attribution_quality
  FROM mcp_call_events e LEFT JOIN mcp_call_outbox o ON o.event_id = e.event_id LEFT JOIN mcp_turns t ON t.id = e.turn_id`;

export class MySqlCollectionRepository implements CollectionRepository {
  constructor(private readonly pool: Pool, private readonly fingerprintKey: Buffer) {}

  private async transaction<T>(work: (connection: PoolConnection) => Promise<T>, advisoryLockKey?: string): Promise<T> {
    const connection = await this.pool.getConnection();
    let lockAcquired = false;
    try {
      if (advisoryLockKey) {
        const [rows] = await connection.query<RowDataPacket[]>("SELECT GET_LOCK(?, 5) AS acquired", [advisoryLockKey]);
        lockAcquired = Number(rows[0]?.acquired) === 1;
        if (!lockAcquired) throw new Error("Candidate turn lock is unavailable");
      }
      await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result;
    } catch (error) { await connection.rollback(); throw error; }
    finally {
      if (lockAcquired) await connection.query("SELECT RELEASE_LOCK(?)", [advisoryLockKey]).catch(() => undefined);
      connection.release();
    }
  }

  async beginCall(input: BeginCallInput): Promise<CallOutboxRecord> {
    await this.pool.execute(`INSERT INTO mcp_call_outbox (event_id, credential_id, platform_owner_id, client_conversation_id, client_turn_id, client_turn_sequence, transport_session_id, session_source, attribution_hint, user_question, question_fingerprint, project_id, service_version_id, tool_version_id, project_key, tool_name, arguments_summary, validation_signals, skill_id, skill_version_id, skill_run_id, skill_step_id, started_at, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [input.id, input.credentialId, input.platformOwnerId, input.attribution.conversationId, input.attribution.clientTurnId, input.attribution.clientTurnSequence, input.attribution.transportSessionId, input.attribution.transportSessionSource, input.attribution.method === "unavailable" ? "missing" : input.attribution.method, input.attribution.userQuestion, input.attribution.questionFingerprint, input.projectId, input.serviceVersionId, input.toolVersionId, input.projectKey, input.toolName, JSON.stringify(input.argumentsSummary), JSON.stringify(input.attribution.qualitySignals), input.skillId ?? null, input.skillVersionId ?? null, input.skillRunId ?? null, input.skillStepId ?? null, input.startedAt, input.startedAt]);
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM mcp_call_outbox WHERE event_id = ?", [input.id]); return outboxFrom(rows[0]!, this.fingerprintKey);
  }
  async completeCall(eventId: string, input: CompleteCallInput): Promise<void> {
    await this.pool.execute("UPDATE mcp_call_outbox SET result_summary = ?, call_status = 'completed', delivery_status = 'ready', outcome = ?, call_error_code = ?, completed_at = ?, duration_ms = ?, updated_at = ? WHERE event_id = ?", [JSON.stringify(input.resultSummary), input.outcome, input.errorCode, input.completedAt, input.durationMs, input.completedAt, eventId]);
  }
  async markCallPartial(eventId: string, errorCode: string, at: Date): Promise<void> {
    await this.pool.execute("UPDATE mcp_call_outbox SET result_summary = JSON_OBJECT('code', ?), call_status = 'partial', delivery_status = 'ready', outcome = 'unknown', call_error_code = ?, completed_at = ?, duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, ?) DIV 1000, updated_at = ? WHERE event_id = ? AND call_status = 'started'", [errorCode, errorCode, at, at, at, eventId]);
  }
  async reconcileStarted(before: Date): Promise<number> {
    const [result] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("UPDATE mcp_call_outbox SET result_summary = JSON_OBJECT('code', 'COLLECTION_COMPLETION_MISSING'), call_status = 'partial', delivery_status = 'ready', outcome = 'unknown', call_error_code = 'COLLECTION_COMPLETION_MISSING', completed_at = ?, duration_ms = TIMESTAMPDIFF(MICROSECOND, started_at, ?) DIV 1000, updated_at = ? WHERE call_status = 'started' AND started_at < ?", [before, before, before, before]); return result.affectedRows;
  }
  async claimReady(workerId: string, now: Date, leaseMs: number, limit: number): Promise<CallOutboxRecord[]> {
    return this.transaction(async (connection) => {
      const [rows] = await connection.query<RowDataPacket[]>(`SELECT * FROM mcp_call_outbox WHERE call_status <> 'started' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) AND (delivery_status = 'ready' OR (delivery_status = 'processing' AND (lease_until IS NULL OR lease_until <= ?))) ORDER BY id LIMIT ? FOR UPDATE SKIP LOCKED`, [now, now, limit]);
      if (!rows.length) return [];
      const ids = rows.map((row) => row.id); const placeholders = ids.map(() => "?").join(",");
      await connection.execute(`UPDATE mcp_call_outbox SET delivery_status = 'processing', lease_owner = ?, lease_until = ?, delivery_attempts = delivery_attempts + 1, updated_at = ? WHERE id IN (${placeholders})`, [workerId, new Date(now.getTime() + leaseMs), now, ...ids]);
      const [claimed] = await connection.query<RowDataPacket[]>(`SELECT * FROM mcp_call_outbox WHERE id IN (${placeholders}) ORDER BY id`, ids); return claimed.map((row) => outboxFrom(row, this.fingerprintKey));
    });
  }
  async markDelivered(eventId: string, workerId: string, at: Date): Promise<boolean> { const [result] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("UPDATE mcp_call_outbox SET delivery_status = 'delivered', delivered_at = ?, lease_owner = NULL, lease_until = NULL, last_error_code = NULL, updated_at = ? WHERE event_id = ? AND delivery_status = 'processing' AND lease_owner = ?", [at, at, eventId, workerId]); return result.affectedRows === 1; }
  async markDeliveryFailure(eventId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number): Promise<boolean> { const [result] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("UPDATE mcp_call_outbox SET delivery_status = IF(delivery_attempts >= ?, 'dead_letter', 'ready'), next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error_code = 'COLLECTION_DELIVERY_FAILED', updated_at = CURRENT_TIMESTAMP(6) WHERE event_id = ? AND delivery_status = 'processing' AND lease_owner = ?", [maxAttempts, nextAttemptAt, eventId, workerId]); return result.affectedRows === 1; }

  async ingestCall(record: CallOutboxRecord, settings: CollectionSettings, now: Date): Promise<CallEvent> {
    const candidateLock = !record.attribution.exactTurnKey && record.attribution.candidateTurnKey
      ? `linkcli:turn:${record.attribution.candidateTurnKey.toString("base64url")}`
      : undefined;
    return this.transaction(async (connection) => {
      const [existingRows] = await connection.query<RowDataPacket[]>(`${eventSelect} WHERE e.event_id = ?`, [record.id]); if (existingRows[0]) return eventFrom(existingRows[0]);
      let turn: ConversationTurn | null = null;
      if (record.attribution.exactTurnKey) {
        const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE exact_turn_key = ? FOR UPDATE", [record.attribution.exactTurnKey]); turn = rows[0] ? turnFrom(rows[0]) : null;
      } else if (record.attribution.candidateTurnKey) {
        const lower = new Date(record.startedAt.getTime() - settings.idleTimeoutMs); const upper = new Date(record.startedAt.getTime() + settings.idleTimeoutMs);
        const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE candidate_key = ? AND lifecycle_status IN ('collecting','grace') AND call_count < ? AND first_event_at <= ? AND last_event_at >= ? ORDER BY last_event_at DESC LIMIT 1 FOR UPDATE", [record.attribution.candidateTurnKey, settings.maxCallsPerTurn, upper, lower]); turn = rows[0] ? turnFrom(rows[0]) : null;
      }
      if (!turn && record.attribution.method !== "unavailable") {
        const id = randomUUID();
        const candidateKey = record.attribution.exactTurnKey ?? record.attribution.candidateTurnKey!;
        const insert = `INSERT INTO mcp_turns (id, credential_id, platform_owner_id, client_conversation_id, client_turn_id, client_turn_sequence, exact_turn_key, transport_session_id, candidate_key, attribution_method, user_question, question_fingerprint, quality_status, first_event_at, last_event_at, behavior_signals) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
        const values = [id, record.credentialId, record.platformOwnerId, record.attribution.conversationId, record.attribution.clientTurnId, record.attribution.clientTurnSequence, record.attribution.exactTurnKey, record.attribution.transportSessionId, candidateKey, record.attribution.method, record.attribution.userQuestion, record.attribution.questionFingerprint, record.status === "partial" ? "partial" : record.attribution.quality, record.startedAt, record.startedAt, JSON.stringify(record.attribution.qualitySignals)];
        if (record.attribution.exactTurnKey) {
          await connection.execute(`${insert} ON DUPLICATE KEY UPDATE id = id`, values);
          const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE exact_turn_key = ? FOR UPDATE", [record.attribution.exactTurnKey]); turn = turnFrom(rows[0]!);
        } else {
          await connection.execute(insert, values);
          const [rows] = await connection.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE id = ? FOR UPDATE", [id]); turn = turnFrom(rows[0]!);
        }
      }
      if (turn) {
        if (turn.lifecycleStatus === "finalized" && record.attribution.exactTurnKey && (!turn.finalizedAt || now.getTime() - turn.finalizedAt.getTime() > settings.lateRevisionMs)) throw new Error("Late revision window expired");
        const lateRevision = turn.lifecycleStatus === "finalized" && Boolean(record.attribution.exactTurnKey) && Boolean(turn.finalizedAt) && now.getTime() - turn.finalizedAt!.getTime() <= settings.lateRevisionMs;
        await connection.execute(`UPDATE mcp_turns SET grace_until = IF(lifecycle_status = 'grace', NULL, grace_until), lifecycle_status = IF(lifecycle_status = 'grace', 'collecting', lifecycle_status), settlement_status = IF(?, 'pending', settlement_status), settlement_revision = settlement_revision + IF(?, 1, 0), settlement_attempts = IF(?, 0, settlement_attempts), next_settlement_at = IF(?, NULL, next_settlement_at), call_count = call_count + 1, error_count = error_count + ?, execution_outcome = CASE WHEN ? = 'error' THEN 'ended_with_error' WHEN ? = 'success' AND error_count > 0 THEN 'recovered_after_error' WHEN ? = 'success' THEN 'all_calls_succeeded' ELSE execution_outcome END, first_event_at = LEAST(first_event_at, ?), last_event_at = GREATEST(last_event_at, ?), quality_status = CASE WHEN quality_status = 'partial' OR ? = 'partial' THEN 'partial' WHEN quality_status = 'suspicious' OR ? = 'suspicious' THEN 'suspicious' ELSE quality_status END, updated_at = ? WHERE id = ?`,
          [lateRevision, lateRevision, lateRevision, lateRevision, record.outcome === "error" ? 1 : 0, record.outcome, record.outcome, record.outcome, record.startedAt, record.startedAt, record.status, record.attribution.quality, now, turn.id]);
      }
      await connection.execute(`INSERT INTO mcp_call_events (event_id, turn_id, ingress_order, credential_id, project_id, service_version_id, tool_version_id, project_key, tool_name, user_question, arguments_summary, result_summary, call_status, outcome, call_error_code, validation_signals, skill_id, skill_version_id, skill_run_id, skill_step_id, started_at, completed_at, duration_ms) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [record.id, turn?.id ?? null, record.ingressSequence, record.credentialId, record.projectId, record.serviceVersionId, record.toolVersionId, record.projectKey, record.toolName, record.attribution.userQuestion, JSON.stringify(record.argumentsSummary), record.resultSummary ? JSON.stringify(record.resultSummary) : null, record.status, record.outcome, record.errorCode, JSON.stringify(record.attribution.qualitySignals), record.skillId ?? null, record.skillVersionId ?? null, record.skillRunId ?? null, record.skillStepId ?? null, record.startedAt, record.completedAt, record.durationMs]);
      const [rows] = await connection.query<RowDataPacket[]>(`${eventSelect} WHERE e.event_id = ?`, [record.id]); return eventFrom(rows[0]!);
    }, candidateLock);
  }

  async advanceTurnLifecycles(settings: CollectionSettings, now: Date): Promise<number> {
    const idleBefore = new Date(now.getTime() - settings.idleTimeoutMs); const graceUntil = new Date(now.getTime() + settings.gracePeriodMs); const lateUntil = new Date(now.getTime() + settings.lateRevisionMs);
    const [grace] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("UPDATE mcp_turns SET lifecycle_status = 'grace', grace_until = ?, end_reason = IF(call_count >= ?, 'call_limit', 'idle_timeout'), updated_at = ? WHERE lifecycle_status = 'collecting' AND (updated_at <= ? OR call_count >= ?)", [graceUntil, settings.maxCallsPerTurn, now, idleBefore, settings.maxCallsPerTurn]);
    const [finalized] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("UPDATE mcp_turns SET lifecycle_status = 'finalized', settlement_status = 'pending', settlement_revision = IF(settlement_revision = 0, 1, settlement_revision), settlement_attempts = 0, next_settlement_at = NULL, finalized_at = COALESCE(finalized_at, ?), late_revision_until = ?, updated_at = ? WHERE lifecycle_status = 'grace' AND grace_until <= ?", [now, lateUntil, now, now]);
    return grace.affectedRows + finalized.affectedRows;
  }
  async settleReadyTurns(now: Date, limit: number): Promise<number> {
    const [turnRows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE lifecycle_status = 'finalized' AND settlement_status <> 'succeeded' AND (next_settlement_at IS NULL OR next_settlement_at <= ?) ORDER BY finalized_at, id LIMIT ?", [now, limit]);
    let settled = 0;
    for (const row of turnRows) {
      try {
        await this.transaction(async (connection) => {
          const [lockedRows] = await connection.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE id = ? FOR UPDATE", [row.id]);
          if (!lockedRows[0]) return;
          const turn = turnFrom(lockedRows[0]);
          if (turn.lifecycleStatus !== "finalized" || turn.settlementStatus === "succeeded") return;
          const [eventRows] = await connection.query<RowDataPacket[]>(`${eventSelect} WHERE e.turn_id = ? ORDER BY e.started_at, e.ingress_order, e.event_id`, [turn.id]); const events = eventRows.map(eventFrom);
          const chain = { calls: canonicalCalls(events) };
          const payload = { turnId: turn.id, revision: turn.revision, attributionMethod: turn.attributionMethod, attributionQuality: turn.attributionQuality, callCount: events.length, canonicalChain: chain };
          const serializedChain = JSON.stringify(chain); const signature = createHash("sha256").update(serializedChain).digest();
          await connection.execute("UPDATE mcp_turns SET canonical_chain = ?, chain_signature = ?, signature_version = 1, settlement_status = 'succeeded', settlement_attempts = 0, next_settlement_at = NULL, last_settlement_error = NULL, updated_at = ? WHERE id = ?", [serializedChain, signature, now, turn.id]);
          if (["trusted", "inferred"].includes(turn.attributionQuality)) await connection.execute("INSERT IGNORE INTO mcp_analysis_outbox (event_id, turn_id, settlement_revision, event_type, payload, next_attempt_at) VALUES (?, ?, ?, 'upsert', ?, ?)", [randomUUID(), turn.id, turn.revision, JSON.stringify(payload), now]);
          settled++;
        });
      } catch {
        const attempts = Number(row.settlement_attempts ?? 0) + 1;
        const nextSettlementAt = new Date(now.getTime() + Math.min(60_000, 1_000 * 2 ** Math.max(0, attempts - 1)));
        await this.pool.execute("UPDATE mcp_turns SET settlement_status = 'failed', settlement_attempts = settlement_attempts + 1, next_settlement_at = ?, last_settlement_error = 'SETTLEMENT_WRITE_FAILED', updated_at = ? WHERE id = ? AND settlement_status <> 'succeeded'", [nextSettlementAt, now, row.id]);
      }
    }
    return settled;
  }
  async purgeExpired(detailBefore: Date, outboxBefore: Date): Promise<{ callEvents: number; outbox: number }> {
    await this.pool.execute("UPDATE mcp_turns SET user_question = NULL, question_fingerprint = NULL, details_purged_at = ? WHERE details_purged_at IS NULL AND last_event_at < ?", [new Date(), detailBefore]);
    const [events] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("DELETE FROM mcp_call_events WHERE started_at < ?", [detailBefore]);
    const [outbox] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("DELETE FROM mcp_call_outbox WHERE (delivery_status = 'delivered' AND updated_at < ?) OR (delivery_status = 'dead_letter' AND updated_at < ?)", [outboxBefore, detailBefore]); return { callEvents: events.affectedRows, outbox: outbox.affectedRows };
  }
  async replayDeadLetter(eventId: string, at: Date): Promise<boolean> { const [result] = await this.pool.execute<import("mysql2/promise").ResultSetHeader>("UPDATE mcp_call_outbox SET delivery_status = 'ready', delivery_attempts = 0, next_attempt_at = ?, lease_owner = NULL, lease_until = NULL, last_error_code = NULL, updated_at = ? WHERE event_id = ? AND delivery_status = 'dead_letter'", [at, at, eventId]); return result.affectedRows === 1; }
  async listOutbox(): Promise<CallOutboxRecord[]> { const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM mcp_call_outbox ORDER BY id"); return rows.map((row) => outboxFrom(row, this.fingerprintKey)); }
  async listTurns(filter?: StatisticsFilter): Promise<ConversationTurn[]> {
    const conditions = ["1=1"]; const params: unknown[] = [];
    if (filter?.from) { conditions.push("t.first_event_at >= ?"); params.push(filter.from); } if (filter?.to) { conditions.push("t.first_event_at < ?"); params.push(filter.to); }
    if (filter?.conversationId) { conditions.push("t.client_conversation_id = ?"); params.push(filter.conversationId); } if (filter?.clientTurnId) { conditions.push("t.client_turn_id = ?"); params.push(filter.clientTurnId); }
    if (filter?.projectIds) {
      if (!filter.projectIds.length) return [];
      const idPlaceholders = filter.projectIds.map(() => "?").join(",");
      let visibility = `EXISTS (SELECT 1 FROM mcp_call_events e WHERE e.turn_id = t.id AND e.project_id IN (${idPlaceholders}))`; params.push(...filter.projectIds);
      if (filter.projectKeys?.length) { const keyPlaceholders = filter.projectKeys.map(() => "?").join(","); visibility += ` OR EXISTS (SELECT 1 FROM JSON_TABLE(COALESCE(t.canonical_chain, JSON_OBJECT('calls', JSON_ARRAY())), '$.calls[*]' COLUMNS(project_key VARCHAR(48) PATH '$.projectKey')) chain_projects WHERE chain_projects.project_key IN (${keyPlaceholders}))`; params.push(...filter.projectKeys); }
      conditions.push(`(${visibility})`);
    }
    const [rows] = await this.pool.query<RowDataPacket[]>(`SELECT t.* FROM mcp_turns t WHERE ${conditions.join(" AND ")} ORDER BY t.first_event_at DESC`, params); return rows.map(turnFrom);
  }
  async getTurn(turnId: string): Promise<ConversationTurn | null> { const [rows] = await this.pool.query<RowDataPacket[]>("SELECT * FROM mcp_turns WHERE id = ?", [turnId]); return rows[0] ? turnFrom(rows[0]) : null; }
  async listCallEvents(filter?: StatisticsFilter & { turnId?: string }): Promise<CallEvent[]> {
    const conditions = ["1=1"]; const params: unknown[] = [];
    if (filter?.turnId) { conditions.push("e.turn_id = ?"); params.push(filter.turnId); } if (filter?.from) { conditions.push("e.started_at >= ?"); params.push(filter.from); } if (filter?.to) { conditions.push("e.started_at < ?"); params.push(filter.to); }
    if (filter?.conversationId) { conditions.push("t.client_conversation_id = ?"); params.push(filter.conversationId); } if (filter?.clientTurnId) { conditions.push("t.client_turn_id = ?"); params.push(filter.clientTurnId); }
    if (filter?.projectIds) { if (!filter.projectIds.length) return []; conditions.push(`e.project_id IN (${filter.projectIds.map(() => "?").join(",")})`); params.push(...filter.projectIds); }
    const [rows] = await this.pool.query<RowDataPacket[]>(`${eventSelect} WHERE ${conditions.join(" AND ")} ORDER BY e.started_at, e.ingress_order, e.event_id`, params); return rows.map(eventFrom);
  }
  async listAnalysisOutbox(): Promise<AnalysisOutboxRecord[]> {
    const [rows] = await this.pool.query<RowDataPacket[]>("SELECT event_id, turn_id, settlement_revision, payload FROM mcp_analysis_outbox ORDER BY id");
    return rows.map((row) => ({ eventId: row.event_id, turnId: row.turn_id, settlementRevision: Number(row.settlement_revision), payload: parseJson<JsonObject>(row.payload) }));
  }
}
