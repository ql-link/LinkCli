import type { AttributionMethod, AttributionQuality, CallEvent, ConversationTurn, PlatformUser } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";
import type { CollectionRepository, StatisticsFilter } from "../collection/repository.js";

export interface StatisticsQuery { from?: Date; to?: Date; projectId?: string; toolName?: string; credentialId?: string; attributionMethod?: AttributionMethod; attributionQuality?: AttributionQuality; turnId?: string; conversationId?: string; clientTurnId?: string; }
interface CallMetric { projectId: string; projectKey: string; toolName: string; outcome: string; status: string; durationMs: number | null; }

export class StatisticsService {
  constructor(private readonly collection: CollectionRepository, private readonly registry: RegistryRepository) {}

  private async filter(user: PlatformUser, query: StatisticsQuery): Promise<StatisticsFilter> {
    const projects = await this.registry.listProjects();
    const visible = user.role === "member" ? projects.filter((project) => project.ownerId === user.id) : projects;
    if (query.projectId && !visible.some((project) => project.id === query.projectId)) throw new AppError("AUTHORIZATION_FAILED", "Project statistics are not available to this account", 403);
    const selected = query.projectId ? visible.filter((project) => project.id === query.projectId) : visible;
    return { projectIds: selected.map((project) => project.id), projectKeys: selected.map((project) => project.projectKey), ...(query.from ? { from: query.from } : {}), ...(query.to ? { to: query.to } : {}), ...(query.conversationId ? { conversationId: query.conversationId } : {}), ...(query.clientTurnId ? { clientTurnId: query.clientTurnId } : {}) };
  }

  private matches(call: CallEvent, query: StatisticsQuery): boolean {
    return (!query.toolName || call.toolName === query.toolName) && (!query.credentialId || call.credentialId === query.credentialId) && (!query.attributionMethod || call.attributionMethod === query.attributionMethod) && (!query.attributionQuality || call.attributionQuality === query.attributionQuality) && (!query.turnId || call.turnId === query.turnId);
  }

  private turnMatches(turn: ConversationTurn, query: StatisticsQuery, projectKeys: string[], visibleCalls: CallEvent[]): boolean {
    const chain = ((turn.canonicalChain?.calls as Array<{ projectKey?: string; toolName?: string }> | undefined) ?? []).filter((call) => call.projectKey && projectKeys.includes(call.projectKey));
    return (!query.turnId || turn.id === query.turnId) && (!query.credentialId || turn.credentialId === query.credentialId) && (!query.attributionMethod || turn.attributionMethod === query.attributionMethod) && (!query.attributionQuality || turn.attributionQuality === query.attributionQuality) && (!query.toolName || visibleCalls.some((call) => call.toolName === query.toolName) || chain.some((call) => call.toolName === query.toolName));
  }

  private percentile(values: number[], fraction: number): number | null {
    if (!values.length) return null; const ordered = values.slice().sort((a, b) => a - b); return ordered[Math.min(ordered.length - 1, Math.ceil(ordered.length * fraction) - 1)]!;
  }

  private async metrics(user: PlatformUser, query: StatisticsQuery): Promise<{ filter: StatisticsFilter; turns: ConversationTurn[]; calls: CallMetric[] }> {
    const filter = await this.filter(user, query); const allCalls = await this.collection.listCallEvents(filter);
    const turns = (await this.collection.listTurns(filter)).filter((turn) => this.turnMatches(turn, query, filter.projectKeys ?? [], allCalls.filter((call) => call.turnId === turn.id)));
    const calls: CallMetric[] = allCalls.filter((call) => this.matches(call, query)); const currentTurnIds = new Set(allCalls.map((call) => call.turnId));
    const projectIdsByKey = new Map((filter.projectKeys ?? []).map((key, index) => [key, filter.projectIds?.[index] ?? ""]));
    for (const turn of turns) {
      if (currentTurnIds.has(turn.id) || !turn.canonicalChain) continue;
      for (const call of (turn.canonicalChain.calls as Array<Record<string, unknown>> | undefined) ?? []) {
        if (typeof call.projectKey !== "string" || !projectIdsByKey.has(call.projectKey) || typeof call.toolName !== "string") continue;
        if (query.toolName && call.toolName !== query.toolName) continue;
        calls.push({ projectId: projectIdsByKey.get(call.projectKey)!, projectKey: call.projectKey, toolName: call.toolName, outcome: typeof call.outcome === "string" ? call.outcome : "unknown", status: typeof call.status === "string" ? call.status : "completed", durationMs: typeof call.durationMs === "number" ? call.durationMs : null });
      }
    }
    return { filter, turns, calls };
  }

  private turnView(turn: ConversationTurn, projectKeys: string[], visibleCalls: CallEvent[] = []) {
    const { exactTurnKey: _exactTurnKey, candidateTurnKey: _candidateTurnKey, questionFingerprint: _questionFingerprint, ...view } = turn;
    const chainCalls = ((turn.canonicalChain?.calls as Array<Record<string, unknown>> | undefined) ?? []).filter((call) => typeof call.projectKey === "string" && projectKeys.includes(call.projectKey));
    const scoped = visibleCalls.length ? visibleCalls : chainCalls;
    const callCount = scoped.length; const errorCount = scoped.filter((call) => call.outcome === "error").length; const partialCount = scoped.filter((call) => call.status === "partial").length;
    return { ...view, userQuestion: visibleCalls.find((call) => call.userQuestion)?.userQuestion ?? (visibleCalls.length ? null : view.userQuestion), callCount, successCount: scoped.filter((call) => call.outcome === "success").length, errorCount, partialCount,
      canonicalChain: turn.canonicalChain ? { calls: chainCalls } : null, exactContext: Boolean(turn.conversationId && turn.clientTurnId) };
  }

  async summary(user: PlatformUser, query: StatisticsQuery = {}) {
    const { turns, calls } = await this.metrics(user, query);
    const quality = Object.fromEntries(["trusted", "inferred", "suspicious", "missing", "partial"].map((name) => [name, turns.filter((turn) => turn.attributionQuality === name).length]));
    const errors = calls.filter((call) => call.outcome === "error").length; const durations = calls.flatMap((call) => call.durationMs === null ? [] : [call.durationMs]);
    return { calls: { total: calls.length, success: calls.filter((call) => call.outcome === "success").length, error: errors, errorRate: calls.length ? errors / calls.length : 0, partial: calls.filter((call) => call.status === "partial").length, durationMs: { p50: this.percentile(durations, 0.5), p95: this.percentile(durations, 0.95), max: durations.length ? Math.max(...durations) : null } }, turns: { total: turns.length, finalized: turns.filter((turn) => turn.lifecycleStatus === "finalized").length, settled: turns.filter((turn) => turn.settlementStatus === "succeeded").length }, attributionQuality: quality };
  }

  async tools(user: PlatformUser, query: StatisticsQuery = {}) {
    const { calls } = await this.metrics(user, query); const groups = new Map<string, { projectId: string; projectKey: string; toolName: string; calls: number; success: number; error: number; partial: number; durationTotal: number; durationSamples: number }>();
    for (const call of calls) {
      const key = `${call.projectId}\0${call.toolName}`; const group = groups.get(key) ?? { projectId: call.projectId, projectKey: call.projectKey, toolName: call.toolName, calls: 0, success: 0, error: 0, partial: 0, durationTotal: 0, durationSamples: 0 };
      group.calls++; if (call.outcome === "success") group.success++; if (call.outcome === "error") group.error++; if (call.status === "partial") group.partial++; if (call.durationMs !== null) { group.durationTotal += call.durationMs; group.durationSamples++; } groups.set(key, group);
    }
    return [...groups.values()].map((group) => ({ ...group, averageDurationMs: group.durationSamples ? Math.round(group.durationTotal / group.durationSamples) : null })).map(({ durationTotal: _total, durationSamples: _samples, ...group }) => group).sort((a, b) => b.calls - a.calls || a.projectKey.localeCompare(b.projectKey) || a.toolName.localeCompare(b.toolName));
  }

  async turns(user: PlatformUser, query: StatisticsQuery = {}) {
    const filter = await this.filter(user, query); const calls = await this.collection.listCallEvents(filter);
    return (await this.collection.listTurns(filter)).filter((turn) => this.turnMatches(turn, query, filter.projectKeys ?? [], calls.filter((call) => call.turnId === turn.id))).map((turn) => this.turnView(turn, filter.projectKeys ?? [], calls.filter((call) => call.turnId === turn.id)));
  }

  async calls(user: PlatformUser, query: StatisticsQuery = {}) { return (await this.collection.listCallEvents(await this.filter(user, query))).filter((call) => this.matches(call, query)); }

  async turn(user: PlatformUser, turnId: string) {
    const turn = assertFound(await this.collection.getTurn(turnId), "Turn not found"); const filter = await this.filter(user, {});
    if (!(await this.collection.listTurns(filter)).some((visible) => visible.id === turnId)) throw new AppError("AUTHORIZATION_FAILED", "Turn is not available to this account", 403);
    const calls = await this.collection.listCallEvents({ ...filter, turnId });
    const parallelByEvent = new Map((((turn.canonicalChain?.calls as Array<{ eventId?: string; parallelGroup?: number | null }> | undefined) ?? [])).map((call) => [call.eventId, call.parallelGroup]));
    return { turn: this.turnView(turn, filter.projectKeys ?? [], calls), calls: calls.map((call) => ({ ...call, parallelGroup: parallelByEvent.get(call.id) ?? null })), detailsPurged: calls.length === 0 && turn.canonicalChain !== null };
  }

  async replayDeadLetter(user: PlatformUser, eventId: string): Promise<void> {
    if (user.role !== "operator") throw new AppError("AUTHORIZATION_FAILED", "Operator role is required", 403);
    if (!await this.collection.replayDeadLetter(eventId, new Date())) throw new AppError("NOT_FOUND", "Dead-letter event not found", 404);
  }
}
