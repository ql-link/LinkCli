import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { approve, createHarness, registerSubmitted } from "./fixtures/harness.js";

async function readyHarness() {
  const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id); return { h, registered };
}

describe("M2 unified gateway", () => {
  it("gives every valid platform credential the same available catalog", async () => {
    const { h } = await readyHarness();
    const first = await h.credentials.issue("agent-a", "Agent A", null); const second = await h.credentials.issue("agent-b", "Agent B", null);
    expect((await h.credentials.authenticate(first.token)).ownerId).toBe("agent-a");
    expect((await h.credentials.authenticate(second.token)).ownerId).toBe("agent-b");
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual(["knowledge__search"]);
  });

  it("rejects missing expired and revoked platform credentials", async () => {
    const { h } = await readyHarness();
    await expect(h.credentials.authenticate(null)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
    const issued = await h.credentials.issue("agent", "Temporary", new Date(Date.now() + 50));
    await h.credentials.revoke(issued.credential.id, "agent");
    await expect(h.credentials.authenticate(issued.token)).rejects.toMatchObject({ code: "AUTHENTICATION_FAILED" });
  });

  it("injects a required original-question field into every public tool", async () => {
    const { h } = await readyHarness(); const tool = (await h.catalog.listTools())[0]!;
    expect(tool.inputSchema.required).toContain(USER_QUESTION_FIELD);
    expect((tool.inputSchema.properties as Record<string, unknown>)[USER_QUESTION_FIELD]).toBeDefined();
  });

  it("uses the project token, strips platform context, and durably records a redacted call", async () => {
    const { h, registered } = await readyHarness();
    const result = await h.gateway.call("knowledge__search", { query: "季度规划", [USER_QUESTION_FIELD]: "公司下一季度如何规划？", apiKey: "should-redact" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "session-1" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    const call = h.connector.endpoints.get(registered.version.endpoint)!.calls[0]!;
    expect(call.token).toBe("project-token");
    expect(call.arguments).toEqual({ query: "季度规划", apiKey: "should-redact" });
    expect(call.arguments).not.toHaveProperty(USER_QUESTION_FIELD);
    const outbox = await h.collection.listOutbox();
    expect(JSON.stringify(outbox[0]?.argumentsSummary)).toContain("[REDACTED]");
    expect(JSON.stringify(outbox[0]?.argumentsSummary)).not.toContain("季度规划");
    expect(outbox[0]).toMatchObject({ status: "completed", deliveryStatus: "ready" });
  });

  it("does not call downstream when the original question is missing", async () => {
    const { h, registered } = await readyHarness();
    await expect(h.gateway.call("knowledge__search", { query: "x" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "s" })).rejects.toMatchObject({ code: "COLLECTION_CONTEXT_INVALID" });
    expect(h.connector.endpoints.get(registered.version.endpoint)!.calls).toHaveLength(0);
  });

  it("never retries a failed downstream call", async () => {
    const { h, registered } = await readyHarness(); h.connector.endpoints.get(registered.version.endpoint)!.error = new AppError("DOWNSTREAM_TIMEOUT", "timeout", 504);
    await expect(h.gateway.call("knowledge__search", { query: "x", [USER_QUESTION_FIELD]: "问题" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "s" })).rejects.toMatchObject({ code: "DOWNSTREAM_TIMEOUT" });
    expect(h.connector.endpoints.get(registered.version.endpoint)!.calls).toHaveLength(1);
  });

  it("does not change the business result when L2 delivery temporarily fails", async () => {
    const { h } = await readyHarness();
    const ingest = h.collection.ingestCall.bind(h.collection);
    h.collection.ingestCall = async () => { throw new Error("L2 unavailable"); };
    const result = await h.gateway.call("knowledge__search", { query: "x", [USER_QUESTION_FIELD]: "问题" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "s" });
    expect(result.content).toEqual([{ type: "text", text: "ok" }]);
    expect((await h.collectionWorker.drainOnce()).failed).toBe(1);
    h.collection.ingestCall = ingest;
  });

  it("removes unhealthy projects after the failure threshold", async () => {
    const { h, registered } = await readyHarness(); h.connector.endpoints.get(registered.version.endpoint)!.error = new Error("downstream failed");
    await expect(h.gateway.call("knowledge__search", { query: "x", [USER_QUESTION_FIELD]: "问题" }, { platformOwnerId: "agent", credentialId: "credential", transportSessionId: "s" })).rejects.toBeTruthy();
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("unhealthy");
    expect(await h.catalog.listTools()).toEqual([]);
  });

  it("treats stale health as unknown and excludes the project", async () => {
    const h = createHarness({ staleAfterMs: 1 }); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(await h.catalog.listTools()).toEqual([]);
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("unknown");
  });
});
