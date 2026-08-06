import { describe, expect, it } from "vitest";
import { USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { approve, createHarness, registerSubmitted, searchTool } from "./fixtures/harness.js";

describe("atomic version switching", () => {
  it("keeps an in-flight call on the old version while new calls use the new version", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const oldState = h.connector.endpoints.get(first.version.endpoint)!;
    let release!: () => void; const gate = new Promise<void>((resolve) => { release = resolve; });
    const originalCall = h.connector.callTool.bind(h.connector);
    h.connector.callTool = async (endpoint, token, name, arguments_, timeout) => {
      if (endpoint === first.version.endpoint) await gate;
      return originalCall(endpoint, token, name, arguments_, timeout);
    };
    const inFlight = h.gateway.call("knowledge__search", { query: "old", [USER_QUESTION_FIELD]: "旧调用" }, { platformOwnerId: "a", sessionId: "s", callSequence: 1 });
    await Promise.resolve();
    h.connector.add("http://project.test/v2", [searchTool("v2")]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    await h.reviews.submit(candidate.version.id, "owner-1"); await approve(h, candidate.version.id);
    const newCall = await h.gateway.call("knowledge__search", { query: "new", [USER_QUESTION_FIELD]: "新调用" }, { platformOwnerId: "a", sessionId: "s", callSequence: 2 });
    release(); await inFlight;
    expect(newCall.content).toBeDefined();
    expect(oldState.calls).toHaveLength(1);
    expect(h.connector.endpoints.get("http://project.test/v2")!.calls).toHaveLength(1);
  });

  it("does not let an older approved candidate overwrite a newer active version", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    h.connector.add("http://project.test/v2", [searchTool("v2")]);
    const second = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    await h.reviews.submit(second.version.id, "owner-1");
    h.connector.add("http://project.test/v3", [searchTool("v3")]);
    const third = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v3", projectToken: "project-token", submittedBy: "owner-1" });
    await h.reviews.submit(third.version.id, "owner-1");
    expect((await approve(h, third.version.id)).published).toBe(true);
    expect((await approve(h, second.version.id)).published).toBe(false);
    expect((await h.repository.getProjectByKey("knowledge"))?.activeVersionId).toBe(third.version.id);
  });
});
