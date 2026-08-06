import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { approve, createHarness, registerSubmitted, searchTool } from "./fixtures/harness.js";

describe("M1 service registry and review", () => {
  it("keeps a first registration out of the catalog until review and health succeed", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h);
    expect(registered.version.reviewStatus).toBe("draft");
    expect((await h.repository.getVersion(registered.version.id))?.reviewStatus).toBe("pending_review");
    expect((await h.repository.getVersion(registered.version.id))?.submittedAt).toBeInstanceOf(Date);
    expect(await h.catalog.listTools()).toEqual([]);
    const result = await approve(h, registered.version.id);
    expect(result.published).toBe(true);
    expect((await h.repository.getProjectByKey("knowledge"))?.status).toBe("active");
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual(["knowledge__search"]);
  });

  it("rejects duplicate downstream tool names without creating a project", async () => {
    const h = createHarness(); h.connector.add("http://duplicate.test/mcp", [searchTool(), searchTool()]);
    await expect(h.projects.register({ projectKey: "duplicate", displayName: "重复", description: "重复工具测试", endpoint: "http://duplicate.test/mcp", projectToken: "project-token", ownerId: "owner-1" })).rejects.toMatchObject({ code: "CONFLICT" });
    expect(await h.repository.getProjectByKey("duplicate")).toBeNull();
  });

  it.each([
    ["invalid endpoint", "not-a-url", undefined, "INVALID_INPUT"],
    ["unsupported transport", "stdio://local-command", undefined, "INVALID_INPUT"],
    ["invalid tool schema", "http://invalid-schema.test/mcp", [{ ...searchTool(), inputSchema: { type: "string" } }], "DOWNSTREAM_PROTOCOL_ERROR"],
  ])("rejects %s without persisting partial registry state", async (_label, endpoint, tools, code) => {
    const h = createHarness();
    if (tools) h.connector.add(endpoint, tools);
    await expect(h.projects.register({ projectKey: "invalid", displayName: "非法服务", description: "发现失败不落库", endpoint, projectToken: "project-token", ownerId: "owner-1" })).rejects.toMatchObject({ code });
    expect(await h.repository.getProjectByKey("invalid")).toBeNull();
    expect(await h.repository.listProjects()).toEqual([]);
  });

  it("preserves a downstream authentication error without persisting a project", async () => {
    const h = createHarness();
    h.connector.discover = async () => { throw new AppError("DOWNSTREAM_AUTH_FAILED", "Downstream MCP authentication failed", 502); };
    await expect(h.projects.register({ projectKey: "denied", displayName: "认证失败", description: "下游拒绝", endpoint: "http://denied.test/mcp", projectToken: "wrong-token", ownerId: "owner-1" })).rejects.toMatchObject({ code: "DOWNSTREAM_AUTH_FAILED" });
    expect(await h.repository.getProjectByKey("denied")).toBeNull();
  });

  it("does not publish an approved version when its first probe fails", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); h.connector.endpoints.get(registered.version.endpoint)!.healthy = false;
    const result = await approve(h, registered.version.id);
    expect(result.published).toBe(false);
    expect((await h.repository.getVersion(registered.version.id))?.reviewStatus).toBe("approved");
    expect((await h.repository.getProjectByKey("knowledge"))?.status).toBe("pending");
    expect(await h.catalog.listTools()).toEqual([]);
    expect(h.events.events.map((event) => event.type)).toContain("health.alert");
  });

  it("keeps the healthy active version available when an approved upgrade probe fails", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    h.connector.add("http://project.test/unhealthy-v2", [searchTool("candidate")]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/unhealthy-v2", projectToken: "project-token", submittedBy: "owner-1" });
    await h.reviews.submit(candidate.version.id, "owner-1");
    h.connector.endpoints.get(candidate.version.endpoint)!.healthy = false;
    expect((await approve(h, candidate.version.id)).published).toBe(false);
    expect((await h.repository.getProjectByKey("knowledge"))?.activeVersionId).toBe(first.version.id);
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("healthy");
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual(["knowledge__search"]);
  });

  it("emits alerts for review and suspension states older than seven days without auto-deciding", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const changed = searchTool(); changed.inputSchema = { type: "object", properties: { query: { type: "number" } }, required: ["query"] };
    h.connector.add("http://project.test/v2", [changed]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    await h.reviews.submit(candidate.version.id, "owner-1");
    const old = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000);
    const stored = (await h.repository.getVersion(candidate.version.id))!; stored.submittedAt = old; await h.repository.updateVersion(stored);
    const project = (await h.repository.getProjectByKey("knowledge"))!;
    const runtime = (await h.repository.getToolRuntime(project.id, "search"))!; runtime.updatedAt = old; await h.repository.upsertToolRuntime(runtime);
    await h.health.emitStaleAlerts(new Date());
    expect(h.events.events.map((event) => event.type)).toContain("review.stale");
    expect(h.events.events.map((event) => event.type)).toContain("tool.suspension.stale");
    expect((await h.repository.getVersion(candidate.version.id))?.reviewStatus).toBe("pending_review");
  });

  it("does not use an old draft creation time as the review-staleness clock", async () => {
    const h = createHarness(); h.connector.add("http://draft.test/mcp", [searchTool()]);
    const registered = await h.projects.register({ projectKey: "draft", displayName: "草稿项目", description: "滞留时间测试", endpoint: "http://draft.test/mcp", projectToken: "project-token", ownerId: "owner-1" });
    const draft = (await h.repository.getVersion(registered.version.id))!;
    draft.createdAt = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
    await h.repository.updateVersion(draft);
    await h.reviews.submit(draft.id, "owner-1");
    await h.health.emitStaleAlerts(new Date());
    expect(h.events.events.map((event) => event.type)).not.toContain("review.stale");
  });

  it("records rejection while keeping the active version online", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    h.connector.add("http://project.test/v2", [searchTool("新的说明")]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    await h.reviews.submit(candidate.version.id, "owner-1"); await h.reviews.decide(candidate.version.id, "rejected", "reviewer-1", "语义不清晰");
    expect((await h.repository.getProjectByKey("knowledge"))?.activeVersionId).toBe(first.version.id);
    expect((await h.repository.getVersion(candidate.version.id))?.reviewStatus).toBe("rejected");
    expect((await h.catalog.listTools())[0]?.description).toBe("搜索内部资料");
    await expect(h.reviews.submit(candidate.version.id, "owner-1")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("requires review for trusted projects while bypass remains disabled", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h);
    expect((await h.repository.getVersion(registered.version.id))?.reviewStatus).toBe("pending_review");
    expect(await h.repository.getReview(registered.version.id)).toBeNull();
  });

  it("bypasses review only after the owner explicitly enables it", async () => {
    const h = createHarness(); h.connector.add("http://trusted.test/mcp", [searchTool()]);
    const registered = await h.projects.register({ projectKey: "trusted", displayName: "可信项目", description: "可信服务", endpoint: "http://trusted.test/mcp", projectToken: "project-token", ownerId: "owner-1" });
    await h.projects.setTrustedBypass("trusted", true); await h.reviews.submit(registered.version.id, "owner-1");
    expect((await h.repository.getReview(registered.version.id))?.decision).toBe("bypassed");
    expect((await h.repository.getVersion(registered.version.id))?.submittedAt).toBeInstanceOf(Date);
    expect((await h.repository.getProjectByKey("trusted"))?.status).toBe("active");
  });

  it("keeps a trusted bypass version unavailable when its first probe fails", async () => {
    const h = createHarness(); h.connector.add("http://trusted-failure.test/mcp", [searchTool()]);
    const registered = await h.projects.register({ projectKey: "trustedfailure", displayName: "可信失败", description: "免审仍需探活", endpoint: "http://trusted-failure.test/mcp", projectToken: "project-token", ownerId: "owner-1" });
    await h.projects.setTrustedBypass("trustedfailure", true);
    h.connector.endpoints.get(registered.version.endpoint)!.healthy = false;
    await h.reviews.submit(registered.version.id, "owner-1");
    expect((await h.repository.getReview(registered.version.id))?.decision).toBe("bypassed");
    expect((await h.repository.getVersion(registered.version.id))?.reviewStatus).toBe("approved");
    expect((await h.repository.getProjectByKey("trustedfailure"))?.status).toBe("pending");
    expect(await h.catalog.listTools()).toEqual([]);
  });

  it("enforces owner, reviewer and terminal-state boundaries", async () => {
    const h = createHarness(); h.connector.add("http://permissions.test/mcp", [searchTool()]);
    const registered = await h.projects.register({ projectKey: "permissions", displayName: "权限", description: "状态权限测试", endpoint: "http://permissions.test/mcp", projectToken: "project-token", ownerId: "owner-1" });
    await expect(h.reviews.submit(registered.version.id, "owner-2")).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await h.reviews.submit(registered.version.id, "owner-1");
    await expect(h.reviews.decide(registered.version.id, "approved", "owner-1", "self review")).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await expect(h.reviews.decide(registered.version.id, "rejected", "reviewer-1", "   ")).rejects.toMatchObject({ code: "INVALID_INPUT" });
    await h.reviews.decide(registered.version.id, "approved", "reviewer-1", "approved");
    await expect(h.reviews.submit(registered.version.id, "owner-1")).rejects.toMatchObject({ code: "INVALID_STATE" });
    await expect(h.projects.createVersion({ projectKey: "permissions", endpoint: "http://permissions.test/mcp", projectToken: "project-token", submittedBy: "owner-2" })).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    expect((await h.repository.getReview(registered.version.id))?.decision).toBe("approved");
  });

  it("returns the existing immutable version for an identical definition", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const duplicate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: first.version.endpoint, projectToken: "project-token", submittedBy: "owner-1" });
    expect(duplicate.version.id).toBe(first.version.id);
    expect(await h.repository.listVersions(first.project.id)).toHaveLength(1);
    expect(await h.repository.getReview(first.version.id)).not.toBeNull();
  });

  it("creates a new immutable version when only the project token rotates", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const state = h.connector.endpoints.get(first.version.endpoint)!; state.token = "rotated-project-token";
    const rotated = await h.projects.createVersion({ projectKey: "knowledge", endpoint: first.version.endpoint, projectToken: "rotated-project-token", submittedBy: "owner-1" });
    expect(rotated.version.id).not.toBe(first.version.id);
    expect(rotated.version.versionNo).toBe(2);
  });

  it("suspends only a high-risk changed tool and restores it after publishing", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const changed = searchTool(); changed.inputSchema = { type: "object", properties: { query: { type: "string" }, scope: { type: "string" } }, required: ["query", "scope"] };
    h.connector.add("http://project.test/v2", [changed, { name: "status", description: "状态", inputSchema: { type: "object", properties: {} }, outputSchema: null }]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    expect(candidate.suspendedTools).toEqual(["search"]);
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual([]);
    await h.reviews.submit(candidate.version.id, "owner-1"); await approve(h, candidate.version.id);
    expect((await h.catalog.listTools()).map((tool) => tool.name).sort()).toEqual(["knowledge__search", "knowledge__status"]);
    expect(h.events.events.map((event) => event.type)).toContain("tool.suspended");
    expect(h.events.events.map((event) => event.type)).toContain("tool.restored");
  });

  it("keeps the active version online during a low-risk description change", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    h.connector.add("http://project.test/v2", [searchTool("仅修改展示说明")]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    expect(candidate.version.riskLevel).toBe("medium");
    expect(candidate.suspendedTools).toEqual([]);
    expect((await h.repository.getProjectByKey("knowledge"))?.activeVersionId).toBe(first.version.id);
    expect((await h.catalog.listTools())[0]?.description).toBe("搜索内部资料");
  });

  it("suspends only the changed tool while unaffected tools continue serving", async () => {
    const h = createHarness();
    const statusTool = { name: "status", description: "读取状态", inputSchema: { type: "object", properties: {} }, outputSchema: null };
    h.connector.add("http://multi.test/v1", [searchTool(), statusTool]);
    const first = await h.projects.register({ projectKey: "multi", displayName: "多工具", description: "局部暂停测试", endpoint: "http://multi.test/v1", projectToken: "project-token", ownerId: "owner-1" });
    await h.reviews.submit(first.version.id, "owner-1"); await approve(h, first.version.id);
    const changed = searchTool(); changed.inputSchema = { type: "object", properties: { query: { type: "string" }, scope: { type: "string" } }, required: ["query", "scope"] };
    h.connector.add("http://multi.test/v2", [changed, statusTool]);
    const candidate = await h.projects.createVersion({ projectKey: "multi", endpoint: "http://multi.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    expect(candidate.suspendedTools).toEqual(["search"]);
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual(["multi__status"]);
  });

  it("restores tools from the active version after a high-risk candidate is rejected", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const changed = searchTool(); changed.inputSchema = { type: "object", properties: { query: { type: "number" } }, required: ["query"] };
    h.connector.add("http://project.test/rejected-v2", [changed]);
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/rejected-v2", projectToken: "project-token", submittedBy: "owner-1" });
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual([]);
    await h.reviews.submit(candidate.version.id, "owner-1");
    await h.reviews.decide(candidate.version.id, "rejected", "reviewer-1", "high-risk change rejected");
    expect((await h.repository.getToolRuntime(first.project.id, "search"))?.status).toBe("active");
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual(["knowledge__search"]);
    expect(h.events.events.map((event) => event.type)).toContain("tool.restored");
  });

  it("keeps committed registry state successful when the L4 event webhook is unavailable", async () => {
    const h = createHarness(); const first = await registerSubmitted(h); await approve(h, first.version.id);
    const changed = searchTool(); changed.inputSchema = { type: "object", properties: { query: { type: "number" } }, required: ["query"] };
    h.connector.add("http://project.test/v2", [changed]); h.events.fail = true;
    const candidate = await h.projects.createVersion({ projectKey: "knowledge", endpoint: "http://project.test/v2", projectToken: "project-token", submittedBy: "owner-1" });
    expect(candidate.suspendedTools).toEqual(["search"]);
    await h.reviews.submit(candidate.version.id, "owner-1");
    expect((await approve(h, candidate.version.id)).published).toBe(true);
    expect((await h.repository.getProjectByKey("knowledge"))?.activeVersionId).toBe(candidate.version.id);
  });

  it("allows exactly one concurrent review decision", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h);
    const results = await Promise.allSettled([
      h.reviews.decide(registered.version.id, "approved", "reviewer-1", "通过"),
      h.reviews.decide(registered.version.id, "rejected", "reviewer-2", "拒绝"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((result) => result.status === "rejected")).toHaveLength(1);
    expect(await h.repository.getReview(registered.version.id)).not.toBeNull();
  });

  it("applies failure and recovery thresholds before changing availability", async () => {
    const h = createHarness({ failureThreshold: 2, recoveryThreshold: 2 }); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    const endpoint = h.connector.endpoints.get(registered.version.endpoint)!;
    endpoint.healthy = false;
    await h.health.probeVersion(registered.version);
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("healthy");
    await h.health.probeVersion(registered.version);
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("unhealthy");
    expect(await h.catalog.listTools()).toEqual([]);
    endpoint.healthy = true;
    await h.health.probeVersion(registered.version);
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("unhealthy");
    await h.health.probeVersion(registered.version);
    expect((await h.repository.getProjectByKey("knowledge"))?.healthStatus).toBe("healthy");
    expect((await h.catalog.listTools()).map((tool) => tool.name)).toEqual(["knowledge__search"]);
  });

  it("lets an in-flight call finish after disable while rejecting new calls", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    let release!: () => void; let entered!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const started = new Promise<void>((resolve) => { entered = resolve; });
    const originalCall = h.connector.callTool.bind(h.connector);
    h.connector.callTool = async (...args) => { entered(); await gate; return originalCall(...args); };
    const inFlight = h.gateway.call("knowledge__search", { query: "old", __linkcli_user_question: "在途调用" }, { platformOwnerId: "agent", sessionId: "disable", callSequence: 1 });
    await started;
    await h.health.changeProjectStatus("knowledge", "disable", "owner-1", false);
    await expect(h.gateway.call("knowledge__search", { query: "new", __linkcli_user_question: "新调用" }, { platformOwnerId: "agent", sessionId: "disable", callSequence: 2 })).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    release();
    await expect(inFlight).resolves.toMatchObject({ content: [{ type: "text", text: "ok" }] });
    expect(h.connector.endpoints.get(registered.version.endpoint)!.calls).toHaveLength(1);
  });

  it("enforces disable-enable-retire transitions and idempotent disable", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    await h.health.changeProjectStatus("knowledge", "disable", "owner-1", false);
    await h.health.changeProjectStatus("knowledge", "disable", "owner-1", false);
    expect(await h.catalog.listTools()).toEqual([]);
    await expect(h.health.changeProjectStatus("knowledge", "retire", "owner-1", false)).rejects.toMatchObject({ code: "AUTHORIZATION_FAILED" });
    await h.health.changeProjectStatus("knowledge", "enable", "owner-1", false);
    await h.health.changeProjectStatus("knowledge", "disable", "owner-1", false);
    await h.health.changeProjectStatus("knowledge", "retire", "operator-1", true);
    await expect(h.health.changeProjectStatus("knowledge", "enable", "owner-1", false)).rejects.toBeInstanceOf(AppError);
    h.connector.add("http://replacement.test/mcp", [searchTool()]);
    await expect(h.projects.register({ projectKey: "knowledge", displayName: "替代项目", description: "不得复用标识", endpoint: "http://replacement.test/mcp", projectToken: "project-token", ownerId: "owner-2" })).rejects.toMatchObject({ code: "CONFLICT" });
  });

  it("requires a successful probe before re-enabling a disabled project", async () => {
    const h = createHarness(); const registered = await registerSubmitted(h); await approve(h, registered.version.id);
    await h.health.changeProjectStatus("knowledge", "disable", "owner-1", false);
    h.connector.endpoints.get(registered.version.endpoint)!.healthy = false;
    await expect(h.health.changeProjectStatus("knowledge", "enable", "owner-1", false)).rejects.toMatchObject({ code: "SERVICE_UNAVAILABLE" });
    expect((await h.repository.getProjectByKey("knowledge"))?.status).toBe("disabled");
    h.connector.endpoints.get(registered.version.endpoint)!.healthy = true;
    await h.health.changeProjectStatus("knowledge", "enable", "owner-1", false);
    expect((await h.repository.getProjectByKey("knowledge"))?.status).toBe("active");
  });
});
