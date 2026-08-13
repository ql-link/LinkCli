import { describe, expect, it } from "vitest";
import { CONVERSATION_META_KEY, TURN_META_KEY, TURN_SEQUENCE_META_KEY, resolveAttribution } from "../src/collection/context.js";
import { MemoryCollectionRepository, type BeginCallInput, type CollectionSettings } from "../src/collection/repository.js";
import { CollectionWorker } from "../src/collection/worker.js";
import { USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { approve, createHarness, registerSubmitted, searchTool } from "./fixtures/harness.js";

const key = Buffer.alloc(32, 31);
const settings: CollectionSettings = { idleTimeoutMs: 300_000, gracePeriodMs: 60_000, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 };

async function readyHarness() { const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id); return { h, registered }; }
const exactMeta = (conversationId: string, turnId: string, sequence = 1) => ({ [CONVERSATION_META_KEY]: conversationId, [TURN_META_KEY]: turnId, [TURN_SEQUENCE_META_KEY]: sequence });

function begin(id: string, startedAt: Date, attribution: ReturnType<typeof resolveAttribution>): BeginCallInput {
  return { id, platformOwnerId: "owner", credentialId: "credential", projectId: "project", serviceVersionId: "version", toolVersionId: "tool-version", projectKey: "knowledge", toolName: "search", argumentsSummary: { query: { type: "string", length: 1 } }, attribution, startedAt };
}

describe("L2 reliable call collection and turn attribution", () => {
  it("rejects downstream tools that already use the reserved compatibility field", async () => {
    const h = createHarness(); const tool = searchTool(); tool.inputSchema = { type: "object", properties: { [USER_QUESTION_FIELD]: { type: "string" } } }; h.connector.add("http://reserved.test/mcp", [tool]);
    await expect(h.projects.register({ projectKey: "reserved", displayName: "Reserved", description: "Reserved field conflict", endpoint: "http://reserved.test/mcp", projectToken: "project-token", ownerId: "owner" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await h.repository.getProjectByKey("reserved")).toBeNull();
  });
  it("puts multiple exact tool calls in one host turn and separates repeated text in another host turn", async () => {
    const { h } = await readyHarness(); const question = "查询本季度经营数据";
    await h.gateway.call("knowledge__search", { query: "first", [USER_QUESTION_FIELD]: question }, { platformOwnerId: "agent", credentialId: "credential-a", transportSessionId: "transport", meta: exactMeta("chat-a", "turn-a") });
    await h.gateway.call("knowledge__search", { query: "second", [USER_QUESTION_FIELD]: question }, { platformOwnerId: "agent", credentialId: "credential-a", transportSessionId: "transport", meta: exactMeta("chat-a", "turn-a") });
    await h.gateway.call("knowledge__search", { query: "third", [USER_QUESTION_FIELD]: question }, { platformOwnerId: "agent", credentialId: "credential-a", transportSessionId: "transport", meta: exactMeta("chat-a", "turn-b", 2) });
    expect((await h.collectionWorker.drainOnce()).delivered).toBe(3);
    const turns = await h.collection.listTurns();
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.callCount).sort()).toEqual([1, 2]);
    expect(new Set(turns.map((turn) => turn.exactTurnKey?.toString("hex"))).size).toBe(2);
  });

  it("isolates concurrent chats and uses session plus normalized question only as a fallback", async () => {
    const { h } = await readyHarness();
    await Promise.all([
      h.gateway.call("knowledge__search", { query: "a", [USER_QUESTION_FIELD]: " 相同\n问题 " }, { platformOwnerId: "agent", credentialId: "credential-a", transportSessionId: "session-a" }),
      h.gateway.call("knowledge__search", { query: "b", [USER_QUESTION_FIELD]: "相同 问题" }, { platformOwnerId: "agent", credentialId: "credential-a", transportSessionId: "session-a" }),
      h.gateway.call("knowledge__search", { query: "c", [USER_QUESTION_FIELD]: "相同 问题" }, { platformOwnerId: "agent", credentialId: "credential-a", transportSessionId: "session-b" }),
    ]);
    await h.collectionWorker.drainOnce();
    const turns = await h.collection.listTurns();
    expect(turns).toHaveLength(2);
    expect(turns.map((turn) => turn.callCount).sort()).toEqual([1, 2]);
    expect(turns.every((turn) => turn.attributionMethod === "session_question")).toBe(true);
  });

  it("hard-rejects only deterministic invalid context and keeps heuristic problems as quality signals", async () => {
    expect(() => resolveAttribution({ credentialId: "c", transportSessionId: null, arguments: {}, fingerprintKey: key })).toThrow(/required/);
    expect(() => resolveAttribution({ credentialId: "c", transportSessionId: null, arguments: { [USER_QUESTION_FIELD]: "x\u0000" }, fingerprintKey: key })).toThrow(/invalid/);
    const context = resolveAttribution({ credentialId: "c", transportSessionId: null, arguments: { query: "entity-a", [USER_QUESTION_FIELD]: "查一下" }, fingerprintKey: key });
    expect(context.quality).toBe("suspicious");
    expect(context.qualitySignals).toEqual(expect.arrayContaining(["generic_or_template_question", "entity_non_overlap"]));
    expect(() => resolveAttribution({ credentialId: "c", transportSessionId: null, arguments: { [USER_QUESTION_FIELD]: "valid" }, meta: { [TURN_SEQUENCE_META_KEY]: 1 }, fingerprintKey: key })).toThrow(/requires/);
  });

  it("normalizes Unicode and whitespace before producing a stable HMAC fingerprint", () => {
    const first = resolveAttribution({ credentialId: "c", transportSessionId: "s", arguments: { [USER_QUESTION_FIELD]: " Cafe\u0301\n  plan " }, fingerprintKey: key });
    const second = resolveAttribution({ credentialId: "c", transportSessionId: "s", arguments: { [USER_QUESTION_FIELD]: "Café plan" }, fingerprintKey: key });
    expect(first.userQuestion).toBe(" Cafe\u0301\n  plan ");
    expect(first.questionFingerprint?.equals(second.questionFingerprint!)).toBe(true);
    expect(first.candidateTurnKey?.equals(second.candidateTurnKey!)).toBe(true);
  });

  it("never calls downstream when the pre-call record fails and never retries after a completed business call", async () => {
    const { h, registered } = await readyHarness();
    const beginCall = h.collection.beginCall.bind(h.collection);
    h.collection.beginCall = async () => { throw new Error("database unavailable"); };
    await expect(h.gateway.call("knowledge__search", { query: "x", [USER_QUESTION_FIELD]: "查询数据" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: null })).rejects.toMatchObject({ code: "COLLECTION_UNAVAILABLE" });
    expect(h.connector.endpoints.get(registered.version.endpoint)!.calls).toHaveLength(0);
    h.collection.beginCall = beginCall;
    h.collection.completeCall = async () => { throw new Error("completion write failed"); };
    await expect(h.gateway.call("knowledge__search", { query: "x", [USER_QUESTION_FIELD]: "查询数据" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: null })).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(h.connector.endpoints.get(registered.version.endpoint)!.calls).toHaveLength(1);
    expect((await h.collection.listOutbox())[0]).toMatchObject({ status: "partial", outcome: "unknown", deliveryStatus: "ready" });
  });

  it("is idempotent and orders a settled chain by start time then durable ingress order", async () => {
    const repository = new MemoryCollectionRepository();
    const attribution = resolveAttribution({ credentialId: "credential", transportSessionId: "session", arguments: { [USER_QUESTION_FIELD]: "同一轮问题" }, fingerprintKey: key });
    await repository.beginCall(begin("later", new Date("2026-01-01T00:00:02Z"), attribution));
    await repository.completeCall("later", { resultSummary: { ok: true }, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:00:04Z"), durationMs: 2_000 });
    await repository.beginCall(begin("earlier", new Date("2026-01-01T00:00:01Z"), attribution));
    await repository.completeCall("earlier", { resultSummary: { ok: true }, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:00:03Z"), durationMs: 2_000 });
    const records = await repository.listOutbox();
    await repository.ingestCall(records[1]!, settings, new Date("2026-01-01T00:00:05Z"));
    await repository.ingestCall(records[0]!, settings, new Date("2026-01-01T00:00:05Z"));
    await repository.ingestCall(records[0]!, settings, new Date("2026-01-01T00:00:05Z"));
    expect((await repository.listCallEvents())).toHaveLength(2);
    expect((await repository.listTurns())[0]?.callCount).toBe(2);
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:10:00Z"));
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:12:00Z"));
    await repository.settleReadyTurns(new Date("2026-01-01T00:12:00Z"), 10);
    const calls = ((await repository.listTurns())[0]?.canonicalChain?.calls as Array<{ eventId: string; parallelGroup: number | null }>);
    expect(calls.map((call) => call.eventId)).toEqual(["earlier", "later"]);
    expect(calls.map((call) => call.parallelGroup)).toEqual([1, 1]);
    expect(await repository.listAnalysisOutbox()).toHaveLength(1);
  });

  it("groups inferred calls by event time even when an outage delays and reorders delivery", async () => {
    const repository = new MemoryCollectionRepository();
    const attribution = resolveAttribution({ credentialId: "credential", transportSessionId: "session", arguments: { [USER_QUESTION_FIELD]: "延迟归集问题" }, fingerprintKey: key });
    await repository.beginCall(begin("first", new Date("2026-01-01T00:00:00Z"), attribution)); await repository.completeCall("first", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:00:01Z"), durationMs: 1_000 });
    await repository.beginCall(begin("second", new Date("2026-01-01T00:00:03Z"), attribution)); await repository.completeCall("second", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:00:04Z"), durationMs: 1_000 });
    const records = await repository.listOutbox();
    await repository.ingestCall(records[1]!, settings, new Date("2026-01-01T02:00:00Z"));
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T02:00:01Z"));
    expect((await repository.listTurns())[0]?.lifecycleStatus).toBe("collecting");
    await repository.ingestCall(records[0]!, settings, new Date("2026-01-01T02:00:02Z"));
    expect(await repository.listTurns()).toHaveLength(1);
    expect((await repository.listTurns())[0]?.callCount).toBe(2);
  });

  it("returns a grace turn to collecting and revises a finalized exact turn for a late event", async () => {
    const repository = new MemoryCollectionRepository();
    const attribution = resolveAttribution({ credentialId: "credential", transportSessionId: null, arguments: { [USER_QUESTION_FIELD]: "精确问题" }, meta: exactMeta("chat", "turn"), fingerprintKey: key });
    await repository.beginCall(begin("one", new Date("2026-01-01T00:00:00Z"), attribution)); await repository.completeCall("one", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:00:01Z"), durationMs: 1_000 });
    await repository.ingestCall((await repository.listOutbox())[0]!, settings, new Date("2026-01-01T00:00:02Z"));
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:06:00Z"));
    expect((await repository.listTurns())[0]?.lifecycleStatus).toBe("grace");
    await repository.beginCall(begin("two", new Date("2026-01-01T00:06:10Z"), attribution)); await repository.completeCall("two", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:06:11Z"), durationMs: 1_000 });
    await repository.ingestCall((await repository.listOutbox())[1]!, settings, new Date("2026-01-01T00:06:12Z"));
    expect((await repository.listTurns())[0]?.lifecycleStatus).toBe("collecting");
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:12:00Z")); await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:14:00Z")); await repository.settleReadyTurns(new Date("2026-01-01T00:14:00Z"), 10);
    await repository.beginCall(begin("late", new Date("2026-01-01T00:15:00Z"), attribution)); await repository.completeCall("late", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:15:01Z"), durationMs: 1_000 });
    await repository.ingestCall((await repository.listOutbox())[2]!, settings, new Date("2026-01-01T00:15:02Z"));
    expect((await repository.listTurns())[0]).toMatchObject({ revision: 2, settlementStatus: "pending", callCount: 3 });
  });

  it("moves repeated delivery failures to dead letter and supports operator replay semantics", async () => {
    const repository = new MemoryCollectionRepository(); let now = new Date("2026-01-01T00:00:00Z");
    const attribution = resolveAttribution({ credentialId: "credential", transportSessionId: null, arguments: { [USER_QUESTION_FIELD]: "失败重放" }, fingerprintKey: key });
    await repository.beginCall(begin("dead", now, attribution)); await repository.completeCall("dead", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: now, durationMs: 0 });
    repository.ingestCall = async () => { throw new Error("collector unavailable"); };
    const worker = new CollectionWorker(repository, settings, { batchSize: 10, leaseMs: 100, startedCallTimeoutMs: 1_000, retryBaseMs: 1 }, () => now);
    for (let attempt = 0; attempt < 3; attempt++) { await worker.drainOnce(); now = new Date(now.getTime() + 10); }
    expect((await repository.listOutbox())[0]?.deliveryStatus).toBe("dead_letter");
    expect(await repository.replayDeadLetter("dead", now)).toBe(true);
    expect((await repository.listOutbox())[0]).toMatchObject({ deliveryStatus: "ready", deliveryAttempts: 0 });
  });

  it("does not publish suspicious or partial turns to the analysis outbox", async () => {
    const repository = new MemoryCollectionRepository();
    const suspicious = resolveAttribution({ credentialId: "credential", transportSessionId: "session", arguments: { query: "entity", [USER_QUESTION_FIELD]: "查一下" }, fingerprintKey: key });
    await repository.beginCall(begin("suspicious", new Date("2026-01-01T00:00:00Z"), suspicious));
    await repository.completeCall("suspicious", { resultSummary: {}, outcome: "success", errorCode: null, completedAt: new Date("2026-01-01T00:00:01Z"), durationMs: 1_000 });
    await repository.ingestCall((await repository.listOutbox())[0]!, settings, new Date("2026-01-01T00:00:02Z"));
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:10:00Z"));
    await repository.advanceTurnLifecycles(settings, new Date("2026-01-01T00:12:00Z"));
    await repository.settleReadyTurns(new Date("2026-01-01T00:12:00Z"), 10);
    expect((await repository.listTurns())[0]?.attributionQuality).toBe("suspicious");
    expect(await repository.listAnalysisOutbox()).toEqual([]);
  });

  it("keeps a stable business error code after the delivered L1 outbox is purged", async () => {
    const repository = new MemoryCollectionRepository(); let now = new Date("2026-01-01T00:00:00Z");
    const attribution = resolveAttribution({ credentialId: "credential", transportSessionId: "session", arguments: { [USER_QUESTION_FIELD]: "错误分类问题" }, fingerprintKey: key });
    await repository.beginCall(begin("business-error", now, attribution));
    await repository.completeCall("business-error", { resultSummary: { code: { type: "string" } }, outcome: "error", errorCode: "DOWNSTREAM_TOOL_ERROR", completedAt: new Date("2026-01-01T00:00:01Z"), durationMs: 1_000 });
    const worker = new CollectionWorker(repository, settings, { batchSize: 10, leaseMs: 1_000, startedCallTimeoutMs: 120_000, retryBaseMs: 10 }, () => now);
    expect((await worker.drainOnce()).delivered).toBe(1);
    now = new Date("2026-01-10T00:00:00Z");
    await repository.purgeExpired(new Date("2025-12-31T00:00:00Z"), new Date("2026-01-02T00:00:00Z"));
    expect(await repository.listOutbox()).toEqual([]);
    expect((await repository.listCallEvents())[0]).toMatchObject({ errorCode: "DOWNSTREAM_TOOL_ERROR", outcome: "error" });
  });
});
