import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { MemoryIdentityRepository } from "../src/auth/repository.js";
import { IdentityService } from "../src/auth/service.js";
import { createApp } from "../src/app.js";
import { StatisticsService } from "../src/statistics/service.js";
import { USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { approve, createHarness, registerSubmitted } from "./fixtures/harness.js";

describe("L2 statistics HTTP API", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close(); });

  it("returns permission-filtered summary and paged turn/call drill-down", async () => {
    const h = createHarness(); const identity = new IdentityService(new MemoryIdentityRepository());
    const owner = await identity.register("stats.owner", "统计负责人", "strong-password-123");
    const registered = await registerSubmitted(h); registered.project.ownerId = owner.id; await h.repository.updateProject(registered.project); await approve(h, registered.version.id);
    await h.gateway.call("knowledge__search", { query: "summary", [USER_QUESTION_FIELD]: "统计接口问题" }, { platformOwnerId: owner.id, credentialId: "credential", transportSessionId: "session" }); await h.collectionWorker.drainOnce();
    const statistics = new StatisticsService(h.collection, h.repository);
    const app = createApp({ projects: h.projects, reviews: h.reviews, health: h.health, credentials: h.credentials, catalog: h.catalog, gateway: h.gateway, collection: h.collection }, "admin-key-with-at-least-24-chars", "127.0.0.1", undefined, { identity, repository: h.repository, projects: h.projects, reviews: h.reviews, health: h.health, credentials: h.credentials, statistics });
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening"); cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const login = await fetch(`${base}/api/auth/login`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: "stats.owner", password: "strong-password-123" }) }); const cookie = login.headers.get("set-cookie")!;
    const summary = await (await fetch(`${base}/api/statistics/summary`, { headers: { cookie } })).json(); expect(summary.data.calls.total).toBe(1);
    const turns = await (await fetch(`${base}/api/statistics/turns?limit=1`, { headers: { cookie } })).json(); expect(turns.data).toHaveLength(1); expect(turns.meta.nextCursor).toBeNull();
    const calls = await (await fetch(`${base}/api/statistics/calls?turnId=${turns.data[0].id}`, { headers: { cookie } })).json(); expect(calls.data).toHaveLength(1);
    const detail = await (await fetch(`${base}/api/statistics/turns/${turns.data[0].id}`, { headers: { cookie } })).json(); expect(detail.data.calls[0].toolName).toBe("search");
  });
});
