import { describe, expect, it } from "vitest";
import type { PlatformUser } from "../src/domain.js";
import { StatisticsService } from "../src/statistics/service.js";
import { USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { CONVERSATION_META_KEY, TURN_META_KEY } from "../src/collection/context.js";
import { approve, createHarness, registerSubmitted, searchTool } from "./fixtures/harness.js";

const user = (id: string, role: PlatformUser["role"]): PlatformUser => ({ id, role, username: id, displayName: id, passwordHash: "not-used", createdAt: new Date(), updatedAt: new Date() });

describe("L2 statistics permissions and drill-down", () => {
  it("lets a project owner inspect only owned calls while reviewers can inspect the platform view", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    await h.gateway.call("knowledge__search", { query: "quarter", [USER_QUESTION_FIELD]: "查询季度规划" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "session" });
    await h.collectionWorker.drainOnce();
    const statistics = new StatisticsService(h.collection, h.repository);
    expect((await statistics.summary(user("owner-1", "member"))).calls.total).toBe(1);
    expect((await statistics.summary(user("owner-2", "member"))).calls.total).toBe(0);
    const turns = await statistics.turns(user("reviewer", "reviewer"));
    expect(turns).toHaveLength(1);
    expect(turns[0]).not.toHaveProperty("questionFingerprint");
    expect(turns[0]).not.toHaveProperty("exactTurnKey");
    expect(turns[0]).not.toHaveProperty("candidateTurnKey");
    const detail = await statistics.turn(user("reviewer", "reviewer"), turns[0]!.id);
    expect(detail.calls).toHaveLength(1);
    await expect(statistics.turn(user("owner-2", "member"), turns[0]!.id)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
  });

  it("allows only operators to replay dead letters", async () => {
    const h = createHarness(); const statistics = new StatisticsService(h.collection, h.repository);
    await expect(statistics.replayDeadLetter(user("reviewer", "reviewer"), "event")).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await expect(statistics.replayDeadLetter(user("operator", "operator"), "event")).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("keeps authorized turn aggregates after ninety-day details are purged", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    await h.gateway.call("knowledge__search", { query: "archive", [USER_QUESTION_FIELD]: "归档统计问题" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "session" });
    await h.collectionWorker.drainOnce();
    const tenMinutesLater = new Date(Date.now() + 10 * 60_000); const twelveMinutesLater = new Date(Date.now() + 12 * 60_000);
    await h.collection.advanceTurnLifecycles(h.collectionSettings, tenMinutesLater); await h.collection.advanceTurnLifecycles(h.collectionSettings, twelveMinutesLater); await h.collection.settleReadyTurns(twelveMinutesLater, 10);
    await h.collection.purgeExpired(new Date(Date.now() + 24 * 60 * 60_000), new Date(Date.now() + 24 * 60 * 60_000));
    const statistics = new StatisticsService(h.collection, h.repository); const turns = await statistics.turns(user("owner-1", "member"));
    expect(turns).toHaveLength(1);
    expect((await statistics.summary(user("owner-1", "member"))).calls.total).toBe(1);
    expect((await statistics.tools(user("owner-1", "member")))[0]).toMatchObject({ projectKey: "knowledge", toolName: "search", calls: 1 });
    expect(await statistics.turn(user("owner-1", "member"), turns[0]!.id)).toMatchObject({ calls: [], detailsPurged: true });
  });

  it("does not expose another project's calls through a shared turn canonical chain", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    h.connector.add("http://project-b.test/mcp", [searchTool()]);
    const second = await h.projects.register({ projectKey: "projectb", displayName: "Project B", description: "Second project", endpoint: "http://project-b.test/mcp", projectToken: "project-token", ownerId: "owner-2" });
    await h.reviews.submit(second.version.id, "owner-2"); await approve(h, second.version.id);
    const meta = { [CONVERSATION_META_KEY]: "shared-chat", [TURN_META_KEY]: "shared-turn" };
    await h.gateway.call("knowledge__search", { query: "a", [USER_QUESTION_FIELD]: "共享轮次问题" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: null, meta });
    await h.gateway.call("projectb__search", { query: "b", [USER_QUESTION_FIELD]: "共享轮次问题" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: null, meta });
    await h.collectionWorker.drainOnce(); const later = new Date(Date.now() + 10 * 60_000); const finalized = new Date(Date.now() + 12 * 60_000);
    await h.collection.advanceTurnLifecycles(h.collectionSettings, later); await h.collection.advanceTurnLifecycles(h.collectionSettings, finalized); await h.collection.settleReadyTurns(finalized, 10);
    const statistics = new StatisticsService(h.collection, h.repository); const turn = (await statistics.turns(user("owner-1", "member")))[0]!; const detail = await statistics.turn(user("owner-1", "member"), turn.id);
    expect(await statistics.turns(user("owner-1", "member"), { conversationId: "shared-chat" })).toHaveLength(1);
    expect(await statistics.turns(user("owner-1", "member"), { conversationId: "another-chat" })).toHaveLength(0);
    expect(detail.calls.map((call) => call.projectKey)).toEqual(["knowledge"]);
    expect((detail.turn.canonicalChain?.calls as Array<{ projectKey: string }>).map((call) => call.projectKey)).toEqual(["knowledge"]);
    expect(detail.turn.callCount).toBe(1);
  });
});
