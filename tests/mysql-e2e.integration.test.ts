import { createHash } from "node:crypto";
import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AnalysisInputConsumer } from "../src/analysis/input-consumer.js";
import { AnalysisOutboxWorker } from "../src/analysis/outbox-worker.js";
import { MySqlAnalysisRepository } from "../src/analysis/repository.js";
import { MySqlCollectionRepository } from "../src/collection/repository.js";
import { CollectionWorker } from "../src/collection/worker.js";
import { MySqlRegistryRepository } from "../src/db/repository.js";
import { CredentialService } from "../src/gateway/auth.js";
import { CatalogService, USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { GatewayRouter } from "../src/gateway/router.js";
import { SdkMcpConnector } from "../src/registry/connector.js";
import { DiscoveryService } from "../src/registry/discovery.js";
import { NoopRegistryEventSink } from "../src/registry/events.js";
import { HealthMonitor } from "../src/registry/health-monitor.js";
import { ProjectService } from "../src/registry/project-service.js";
import { ReviewService } from "../src/registry/review-service.js";
import { ProjectCredentialCipher } from "../src/security/project-credential.js";

const databaseUrl = process.env.LINKCLI_TEST_MYSQL_URL;
const realMySqlDescribe = databaseUrl ? describe : describe.skip;
const adminKey = "mysql-e2e-admin-key-at-least-24-characters";
const projectToken = "mysql-e2e-project-token";

async function resetDatabase(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const [[identity]] = await connection.query<mysql.RowDataPacket[]>("SELECT DATABASE() AS name");
    if (!identity) throw new Error("Unable to resolve integration database name");
    const name = String(identity.name ?? "");
    if (!/(?:_dev|_test)$/.test(name)) throw new Error(`Refusing to reset non-test database: ${name}`);
    await connection.query("SET FOREIGN_KEY_CHECKS=0");
    try {
      for (const table of ["mcp_l4_validation_feedback", "mcp_l4_candidate_outbox", "mcp_cluster_score_history", "mcp_skill_coverage_gap", "mcp_query_cluster_scene", "mcp_query_cluster_member", "mcp_query_cluster", "mcp_analysis_input", "mcp_analysis_outbox", "mcp_call_events", "mcp_turns", "mcp_call_outbox", "mcp_reviews", "mcp_tool_runtime", "mcp_tool_versions", "mcp_service_versions", "mcp_projects", "mcp_call_credentials"]) {
        await connection.query(`TRUNCATE TABLE \`${table}\``);
      }
    } finally {
      await connection.query("SET FOREIGN_KEY_CHECKS=1");
    }
  } finally {
    connection.release();
  }
}

function createServices(pool: Pool) {
  const repository = new MySqlRegistryRepository(pool, pool);
  const collection = new MySqlCollectionRepository(pool, Buffer.alloc(32, 23));
  const connector = new SdkMcpConnector();
  const cipher = new ProjectCredentialCipher(Buffer.alloc(32, 19).toString("base64"), "mysql-e2e-v1");
  const events = new NoopRegistryEventSink();
  const discovery = new DiscoveryService(connector, 5_000);
  const health = new HealthMonitor(repository, connector, cipher, 2, 1, 5_000, events);
  const projects = new ProjectService(repository, discovery, cipher, events);
  const reviews = new ReviewService(repository, health, events);
  const credentials = new CredentialService(repository);
  const catalog = new CatalogService(repository, 60_000);
  const gateway = new GatewayRouter(repository, catalog, connector, cipher, health, collection, Buffer.alloc(32, 23), 5_000);
  const collectionWorker = new CollectionWorker(collection, { idleTimeoutMs: 300_000, gracePeriodMs: 60_000, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, { batchSize: 100, leaseMs: 30_000, startedCallTimeoutMs: 120_000, retryBaseMs: 10 });
  return { repository, collection, collectionWorker, projects, reviews, health, credentials, catalog, gateway };
}

async function listen(app: ReturnType<typeof createMcpExpressApp>): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const { port } = server.address() as AddressInfo;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

async function startDownstream(): Promise<{ endpoint: string; calls: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const calls: Array<Record<string, unknown>> = [];
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use(express.json());
  app.all("/mcp", async (req: Request, res: Response) => {
    if (req.header("authorization") !== `Bearer ${projectToken}`) {
      res.status(401).json({ error: "unauthorized" });
      return;
    }
    const server = new Server({ name: "mysql-e2e-downstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{
      name: "echo",
      description: "Return the supplied message",
      inputSchema: { type: "object", properties: { message: { type: "string" } }, required: ["message"] },
    }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      calls.push(request.params.arguments ?? {});
      if (request.params.arguments?.message === "business-error") return { content: [{ type: "text", text: "rejected" }], isError: true };
      return { content: [{ type: "text", text: `echo:${String(request.params.arguments?.message ?? "")}` }] };
    });
    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } finally {
      await transport.close().catch(() => undefined);
      await server.close().catch(() => undefined);
    }
  });
  const running = await listen(app);
  return { endpoint: `${running.baseUrl}/mcp`, calls, close: running.close };
}

realMySqlDescribe("real MySQL and standard MCP end-to-end", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = mysql.createPool({ uri: databaseUrl!, connectionLimit: 5, timezone: "Z", dateStrings: false });
  });
  beforeEach(async () => {
    await resetDatabase(pool);
  }, 60_000);
  afterEach(async () => {
    await resetDatabase(pool);
  }, 60_000);
  afterAll(async () => {
    await pool.end();
  });

  it("persists registration, review, publication and gateway calls across a restart", async () => {
    const downstream = await startDownstream();
    let linkcli: Awaited<ReturnType<typeof listen>> | undefined;
    let client: Client | undefined;
    try {
      const services = createServices(pool);
      linkcli = await listen(createApp(services, adminKey));
      const ownerHeaders = { "content-type": "application/json", "x-admin-api-key": adminKey, "x-platform-user-id": "owner-e2e", "x-platform-role": "owner" };
      const registered = await fetch(`${linkcli.baseUrl}/admin/projects`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ projectKey: "devfixture", displayName: "Dev fixture", description: "Real MySQL integration fixture", endpoint: downstream.endpoint, projectToken }) });
      expect(registered.status).toBe(201);
      const registeredBody = await registered.json() as { version: { id: string; submittedAt: string | null } };
      expect(registeredBody.version.submittedAt).toBeNull();

      const submitted = await fetch(`${linkcli.baseUrl}/admin/versions/${registeredBody.version.id}/submit`, { method: "POST", headers: ownerHeaders });
      expect(submitted.status).toBe(200);
      expect((await submitted.json() as { submittedAt: string | null }).submittedAt).not.toBeNull();

      const reviewed = await fetch(`${linkcli.baseUrl}/admin/versions/${registeredBody.version.id}/review`, { method: "POST", headers: { ...ownerHeaders, "x-platform-user-id": "reviewer-e2e", "x-platform-role": "reviewer" }, body: JSON.stringify({ decision: "approved", comment: "real environment approved" }) });
      expect(reviewed.status).toBe(200);
      expect((await reviewed.json() as { published: boolean }).published).toBe(true);

      const issued = await fetch(`${linkcli.baseUrl}/admin/credentials`, { method: "POST", headers: { ...ownerHeaders, "x-platform-user-id": "agent-e2e", "x-platform-role": "platform_user" }, body: JSON.stringify({ credentialName: "Real environment token" }) });
      expect(issued.status).toBe(201);
      const token = (await issued.json() as { token: string }).token;

      await linkcli.close();
      const restartedServices = createServices(pool);
      linkcli = await listen(createApp(restartedServices, adminKey));
      client = new Client({ name: "mysql-e2e-client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${linkcli.baseUrl}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${token}`, "x-linkcli-session-id": "mysql-e2e" } } }));
      expect((await client.listTools()).tools.map((tool) => tool.name)).toEqual(["devfixture__echo"]);
      const result = await client.callTool({ name: "devfixture__echo", arguments: { message: "hello", [USER_QUESTION_FIELD]: "请回显 hello" } });
      expect(result.content).toEqual([{ type: "text", text: "echo:hello" }]);
      expect(downstream.calls).toEqual([{ message: "hello" }]);
      expect((await restartedServices.collectionWorker.drainOnce()).delivered).toBe(1);
      const collectionSettings = { idleTimeoutMs:1,gracePeriodMs:1,lateRevisionMs:86_400_000,maxCallsPerTurn:100,maxDeliveryAttempts:3 };
      const settlementAt = new Date(Date.now()+10_000);
      await restartedServices.collection.advanceTurnLifecycles(collectionSettings,settlementAt);
      await restartedServices.collection.advanceTurnLifecycles(collectionSettings,new Date(settlementAt.getTime()+2));
      expect(await restartedServices.collection.settleReadyTurns(new Date(settlementAt.getTime()+3),100)).toBe(1);
      const analysisInput = new AnalysisInputConsumer(new MySqlAnalysisRepository(pool,pool));
      const analysisOutbox = new AnalysisOutboxWorker(pool,analysisInput,{batchSize:100,leaseMs:30_000,maxAttempts:3,retryBaseMs:10},()=>new Date(settlementAt.getTime()+4));
      expect(await analysisOutbox.drainOnce()).toMatchObject({claimed:1,delivered:1,failed:0});
      expect(await analysisOutbox.drainOnce()).toMatchObject({claimed:0,delivered:0});
      const [[analysisState]] = await pool.query<mysql.RowDataPacket[]>("SELECT event_id,turn_id,settlement_version,actor_hash,query_text,module_path,calls,collection_trust FROM mcp_analysis_input");
      if (!analysisState) throw new Error("L2 analysis outbox was not converted to an L3 input");
      expect(analysisState).toMatchObject({settlement_version:1,actor_hash:createHash("sha256").update("agent-e2e").digest("hex"),query_text:"请回显 hello",collection_trust:"trusted"});
      expect(typeof analysisState.event_id).toBe("string");
      expect(typeof analysisState.turn_id).toBe("string");
      expect(typeof analysisState.calls === "string" ? JSON.parse(analysisState.calls) : analysisState.calls).toEqual([{sequence:1,projectId:expect.any(String),toolName:"echo",serviceVersionId:expect.any(String),toolVersionId:expect.any(String),operation:"execute",parameterKeys:["message"],outcome:"success"}]);
      expect(typeof analysisState.module_path === "string" ? JSON.parse(analysisState.module_path) : analysisState.module_path).toBeNull();
      const [[analysisDelivery]] = await pool.query<mysql.RowDataPacket[]>("SELECT delivery_status,delivery_attempts,last_error_code FROM mcp_analysis_outbox");
      expect(analysisDelivery).toMatchObject({delivery_status:"delivered",delivery_attempts:1,last_error_code:null});
      let retryAt = new Date(settlementAt.getTime()+10);
      await pool.execute("INSERT INTO mcp_analysis_outbox (event_id,turn_id,settlement_revision,event_type,payload,delivery_status,next_attempt_at) SELECT '00000000-0000-4000-8000-000000000001',turn_id,settlement_revision,'retract',JSON_OBJECT(),'pending',? FROM mcp_analysis_outbox WHERE event_type='upsert' LIMIT 1",[retryAt]);
      const failingAnalysisOutbox = new AnalysisOutboxWorker(pool,analysisInput,{batchSize:100,leaseMs:30_000,maxAttempts:2,retryBaseMs:10},()=>retryAt);
      expect(await failingAnalysisOutbox.drainOnce()).toMatchObject({claimed:1,failed:1,deadLettered:0});
      retryAt = new Date(retryAt.getTime()+10);
      expect(await failingAnalysisOutbox.drainOnce()).toMatchObject({claimed:1,failed:1,deadLettered:1});
      const [[deadAnalysisDelivery]] = await pool.query<mysql.RowDataPacket[]>("SELECT delivery_status,delivery_attempts,last_error_code FROM mcp_analysis_outbox WHERE event_type='retract'");
      expect(deadAnalysisDelivery).toMatchObject({delivery_status:"dead_letter",delivery_attempts:2,last_error_code:"UNSUPPORTED_ANALYSIS_EVENT"});

      const [[state]] = await pool.query<mysql.RowDataPacket[]>(`SELECT p.status, p.health_status, v.review_status, v.submitted_at, r.decision
        FROM mcp_projects p
        JOIN mcp_service_versions v ON v.id = p.active_version_id
        JOIN mcp_reviews r ON r.service_version_id = v.id
        WHERE p.project_key = 'devfixture'`);
      if (!state) throw new Error("Persisted project state was not found");
      expect(state).toMatchObject({ status: "active", health_status: "healthy", review_status: "approved", decision: "approved" });
      expect(state.submitted_at).toBeInstanceOf(Date);
      const [[credentialCount]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS count FROM mcp_call_credentials WHERE owner_id = 'agent-e2e' AND token_digest IS NOT NULL");
      if (!credentialCount) throw new Error("Persisted credential count was not returned");
      expect(Number(credentialCount.count)).toBe(1);
      const [[collectionCount]] = await pool.query<mysql.RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM mcp_call_events) AS calls, (SELECT COUNT(*) FROM mcp_turns) AS turns");
      expect(collectionCount).toMatchObject({ calls: 1, turns: 1 });

      await Promise.all([
        client.callTool({ name: "devfixture__echo", arguments: { message: "parallel-a", [USER_QUESTION_FIELD]: "同一轮并发问题" } }),
        client.callTool({ name: "devfixture__echo", arguments: { message: "parallel-b", [USER_QUESTION_FIELD]: "同一轮并发问题" } }),
      ]);
      const concurrentRecords = (await restartedServices.collection.listOutbox()).filter((record) => record.deliveryStatus === "ready");
      await Promise.all(concurrentRecords.map((record) => restartedServices.collection.ingestCall(record, { idleTimeoutMs: 300_000, gracePeriodMs: 60_000, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, new Date())));
      const [[concurrentState]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) turns, MAX(call_count) max_calls FROM mcp_turns WHERE user_question = '同一轮并发问题'");
      expect(concurrentState).toMatchObject({ turns: 1, max_calls: 2 });

      await client.callTool({ name: "devfixture__echo", arguments: { message: "business-error", [USER_QUESTION_FIELD]: "错误分类问题" } });
      const errorRecord = (await restartedServices.collection.listOutbox()).find((record) => record.errorCode === "DOWNSTREAM_TOOL_ERROR");
      expect(errorRecord).toBeDefined();
      await restartedServices.collection.ingestCall(errorRecord!, { idleTimeoutMs: 300_000, gracePeriodMs: 60_000, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, new Date());
      const [errorEvents] = await pool.query<mysql.RowDataPacket[]>("SELECT call_error_code FROM mcp_call_events WHERE event_id = ?", [errorRecord!.id]);
      expect(errorEvents[0]).toMatchObject({ call_error_code: "DOWNSTREAM_TOOL_ERROR" });
    } finally {
      await client?.close().catch(() => undefined);
      await linkcli?.close().catch(() => undefined);
      await downstream.close().catch(() => undefined);
    }
  }, 60_000);

  it("keeps real connection, authentication and protocol failures out of the registry", async () => {
    const downstream = await startDownstream();
    const closedServer = await listen(createMcpExpressApp({ host: "127.0.0.1" }));
    const closedEndpoint = `${closedServer.baseUrl}/mcp`;
    await closedServer.close();
    const incompatibleApp = createMcpExpressApp({ host: "127.0.0.1" });
    incompatibleApp.use(express.json());
    incompatibleApp.all("/mcp", (_req, res) => res.json({ service: "ordinary-http", tools: [] }));
    const incompatible = await listen(incompatibleApp);
    const services = createServices(pool);
    const linkcli = await listen(createApp(services, adminKey));
    try {
      const cases = [
        { key: "authfailure", endpoint: downstream.endpoint, token: "wrong-project-token", code: "DOWNSTREAM_AUTH_FAILED" },
        { key: "connectionfailure", endpoint: closedEndpoint, token: projectToken, code: "DOWNSTREAM_CONNECTION_FAILED" },
        { key: "protocolfailure", endpoint: `${incompatible.baseUrl}/mcp`, token: undefined, code: "DOWNSTREAM_PROTOCOL_ERROR" },
      ];
      for (const item of cases) {
        const response = await fetch(`${linkcli.baseUrl}/admin/projects`, {
          method: "POST",
          headers: { "content-type": "application/json", "x-admin-api-key": adminKey, "x-platform-user-id": "owner-auth", "x-platform-role": "owner" },
          body: JSON.stringify({ projectKey: item.key, displayName: item.key, description: "Rejected downstream registration", endpoint: item.endpoint, projectToken: item.token }),
        });
        expect(response.status).toBe(502);
        expect(await response.json()).toMatchObject({ error: { code: item.code } });
      }
      const [[counts]] = await pool.query<mysql.RowDataPacket[]>("SELECT (SELECT COUNT(*) FROM mcp_projects) projects, (SELECT COUNT(*) FROM mcp_service_versions) versions, (SELECT COUNT(*) FROM mcp_tool_versions) tools_count");
      expect(counts).toMatchObject({ projects: 0, versions: 0, tools_count: 0 });
    } finally {
      await linkcli.close().catch(() => undefined);
      await downstream.close().catch(() => undefined);
      await incompatible.close().catch(() => undefined);
    }
  }, 60_000);

  it("enforces real MySQL review concurrency, idempotency and lifecycle transitions", async () => {
    const downstream = await startDownstream();
    const candidateDownstream = await startDownstream();
    const services = createServices(pool);
    const linkcli = await listen(createApp(services, adminKey));
    const ownerHeaders = { "content-type": "application/json", "x-admin-api-key": adminKey, "x-platform-user-id": "owner-state", "x-platform-role": "owner" };
    try {
      const register = async (projectKey: string) => {
        const response = await fetch(`${linkcli.baseUrl}/admin/projects`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ projectKey, displayName: projectKey, description: "Real state transition fixture", endpoint: downstream.endpoint, projectToken }) });
        expect(response.status).toBe(201);
        return response.json() as Promise<{ version: { id: string } }>;
      };

      const concurrent = await register("concurrent");
      expect((await fetch(`${linkcli.baseUrl}/admin/versions/${concurrent.version.id}/submit`, { method: "POST", headers: ownerHeaders })).status).toBe(200);
      const decisions = await Promise.all([
        fetch(`${linkcli.baseUrl}/admin/versions/${concurrent.version.id}/review`, { method: "POST", headers: { ...ownerHeaders, "x-platform-user-id": "reviewer-approve", "x-platform-role": "reviewer" }, body: JSON.stringify({ decision: "approved", comment: "approve first race" }) }),
        fetch(`${linkcli.baseUrl}/admin/versions/${concurrent.version.id}/review`, { method: "POST", headers: { ...ownerHeaders, "x-platform-user-id": "reviewer-reject", "x-platform-role": "reviewer" }, body: JSON.stringify({ decision: "rejected", comment: "reject first race" }) }),
      ]);
      expect(decisions.map((response) => response.status).sort()).toEqual([200, 409]);
      const accepted = decisions.find((response) => response.status === 200)!;
      const conflict = decisions.find((response) => response.status === 409)!;
      const acceptedBody = await accepted.json() as { version: { reviewStatus: string } };
      expect(await conflict.json()).toMatchObject({ error: { code: "CONFLICT", details: { currentStatus: acceptedBody.version.reviewStatus } } });
      const [[reviewCount]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) count, COUNT(DISTINCT decision) decisions FROM mcp_reviews WHERE service_version_id=?", [concurrent.version.id]);
      expect(reviewCount).toMatchObject({ count: 1, decisions: 1 });

      const idempotent = await register("idempotent");
      const concurrentVersions = await Promise.all([
        fetch(`${linkcli.baseUrl}/admin/projects/idempotent/versions`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ endpoint: candidateDownstream.endpoint, projectToken }) }),
        fetch(`${linkcli.baseUrl}/admin/projects/idempotent/versions`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ endpoint: candidateDownstream.endpoint, projectToken }) }),
      ]);
      expect(concurrentVersions.map((response) => response.status)).toEqual([201, 201]);
      const concurrentVersionBodies = await Promise.all(concurrentVersions.map((response) => response.json() as Promise<{ version: { id: string } }>));
      expect(new Set(concurrentVersionBodies.map((body) => body.version.id)).size).toBe(1);
      const [[idempotentCount]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) count FROM mcp_service_versions WHERE project_id=(SELECT id FROM mcp_projects WHERE project_key='idempotent')");
      expect(Number(idempotentCount?.count)).toBe(2);
      expect(idempotent.version.id).not.toBe(concurrentVersionBodies[0]?.version.id);

      const lifecycle = await register("lifecycle");
      await fetch(`${linkcli.baseUrl}/admin/versions/${lifecycle.version.id}/submit`, { method: "POST", headers: ownerHeaders });
      const approved = await fetch(`${linkcli.baseUrl}/admin/versions/${lifecycle.version.id}/review`, { method: "POST", headers: { ...ownerHeaders, "x-platform-user-id": "reviewer-state", "x-platform-role": "reviewer" }, body: JSON.stringify({ decision: "approved", comment: "publish lifecycle" }) });
      expect(approved.status).toBe(200);
      expect((await approved.json() as { published: boolean }).published).toBe(true);

      const duplicate = await fetch(`${linkcli.baseUrl}/admin/projects/lifecycle/versions`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ endpoint: downstream.endpoint, projectToken }) });
      expect(duplicate.status).toBe(201);
      expect((await duplicate.json() as { version: { id: string } }).version.id).toBe(lifecycle.version.id);
      const [[versionCount]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) count FROM mcp_service_versions v JOIN mcp_projects p ON p.id=v.project_id WHERE p.project_key='lifecycle'");
      if (!versionCount) throw new Error("Version count was not returned");
      expect(Number(versionCount.count)).toBe(1);

      const status = async (action: "disable" | "enable" | "retire", role: "owner" | "operator" = "owner") => fetch(`${linkcli.baseUrl}/admin/projects/lifecycle/status`, { method: "PATCH", headers: { ...ownerHeaders, "x-platform-user-id": role === "operator" ? "operator-state" : "owner-state", "x-platform-role": role }, body: JSON.stringify({ action }) });
      expect((await status("disable")).status).toBe(200);
      expect((await status("disable")).status).toBe(200);
      expect((await status("enable")).status).toBe(200);
      expect((await status("retire", "operator")).status).toBe(409);
      expect((await status("disable")).status).toBe(200);
      expect((await status("retire", "operator")).status).toBe(200);
      const replacement = await fetch(`${linkcli.baseUrl}/admin/projects`, { method: "POST", headers: ownerHeaders, body: JSON.stringify({ projectKey: "lifecycle", displayName: "replacement", description: "must not reuse retired key", endpoint: downstream.endpoint, projectToken }) });
      expect(replacement.status).toBe(409);
      const [[projectState]] = await pool.query<mysql.RowDataPacket[]>("SELECT status, active_version_id FROM mcp_projects WHERE project_key='lifecycle'");
      expect(projectState).toMatchObject({ status: "retired", active_version_id: lifecycle.version.id });
    } finally {
      await linkcli.close().catch(() => undefined);
      await downstream.close().catch(() => undefined);
      await candidateDownstream.close().catch(() => undefined);
    }
  }, 90_000);
});
