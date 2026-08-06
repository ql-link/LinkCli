import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { createHarness, searchTool } from "./fixtures/harness.js";

describe("protected management HTTP API", () => {
  const cleanup: Array<() => Promise<void>> = [];
  afterEach(async () => { for (const item of cleanup.splice(0).reverse()) await item(); });

  async function start() {
    const h = createHarness();
    const app = createApp({ projects: h.projects, reviews: h.reviews, health: h.health, credentials: h.credentials, catalog: h.catalog, gateway: h.gateway }, "admin-key-with-at-least-24-chars");
    const server = app.listen(0, "127.0.0.1"); await once(server, "listening");
    cleanup.push(() => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())));
    const { port } = server.address() as AddressInfo;
    return { h, baseUrl: `http://127.0.0.1:${port}` };
  }

  const headers = (role = "owner", userId = "owner-1") => ({ "content-type": "application/json", "x-admin-api-key": "admin-key-with-at-least-24-chars", "x-platform-user-id": userId, "x-platform-role": role });

  it("rejects requests without the deployment admin key", async () => {
    const { baseUrl } = await start();
    const response = await fetch(`${baseUrl}/admin/credentials`, { headers: { "x-platform-user-id": "agent", "x-platform-role": "platform_user" } });
    expect(response.status).toBe(401);
  });

  it("registers a project without returning its project token or ciphertext", async () => {
    const { h, baseUrl } = await start(); h.connector.add("http://managed.test/mcp", [searchTool()], "secret-project-token");
    const response = await fetch(`${baseUrl}/admin/projects`, { method: "POST", headers: headers(), body: JSON.stringify({ projectKey: "managed", displayName: "管理项目", description: "API 登记", endpoint: "http://managed.test/mcp", projectToken: "secret-project-token" }) });
    expect(response.status).toBe(201);
    const body = await response.text();
    expect(body).not.toContain("secret-project-token");
    expect(body).not.toContain("credentialCiphertext");
  });

  it("returns a platform token only on creation and never exposes its digest", async () => {
    const { baseUrl } = await start();
    const created = await fetch(`${baseUrl}/admin/credentials`, { method: "POST", headers: headers("platform_user", "agent-1"), body: JSON.stringify({ credentialName: "Agent token" }) });
    expect(created.status).toBe(201);
    const body = await created.json() as { token: string; credential: { id: string } };
    expect(body.token).toMatch(/^lkc_/);
    expect(JSON.stringify(body)).not.toContain("tokenDigest");
    const listed = await fetch(`${baseUrl}/admin/credentials`, { headers: headers("platform_user", "agent-1") });
    const listBody = await listed.text();
    expect(listBody).not.toContain(body.token);
    expect(listBody).not.toContain("tokenDigest");
  });

  it("enforces management roles before changing review bypass or version state", async () => {
    const { h, baseUrl } = await start(); h.connector.add("http://roles.test/mcp", [searchTool()]);
    const registered = await fetch(`${baseUrl}/admin/projects`, { method: "POST", headers: headers(), body: JSON.stringify({ projectKey: "roles", displayName: "角色测试", description: "管理权限边界", endpoint: "http://roles.test/mcp", projectToken: "project-token" }) });
    const versionId = (await registered.json() as { version: { id: string } }).version.id;

    const reviewerBypass = await fetch(`${baseUrl}/admin/projects/roles/trusted-review-bypass`, { method: "PATCH", headers: headers("reviewer", "reviewer-1"), body: JSON.stringify({ enabled: true }) });
    expect(reviewerBypass.status).toBe(403);
    expect((await h.repository.getProjectByKey("roles"))?.trustedReviewBypassEnabled).toBe(false);

    const operatorBypass = await fetch(`${baseUrl}/admin/projects/roles/trusted-review-bypass`, { method: "PATCH", headers: headers("operator", "operator-1"), body: JSON.stringify({ enabled: true }) });
    expect(operatorBypass.status).toBe(200);
    expect((await h.repository.getProjectByKey("roles"))?.trustedReviewBypassEnabled).toBe(true);

    const reviewerSubmit = await fetch(`${baseUrl}/admin/versions/${versionId}/submit`, { method: "POST", headers: headers("reviewer", "reviewer-1") });
    expect(reviewerSubmit.status).toBe(403);
    expect((await h.repository.getVersion(versionId))?.reviewStatus).toBe("draft");
  });
});
