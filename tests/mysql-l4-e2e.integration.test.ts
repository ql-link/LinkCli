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
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AnalysisBatchService } from "../src/analysis/batch-service.js";
import { AnalysisInputConsumer } from "../src/analysis/input-consumer.js";
import type { ClusterJudge } from "../src/analysis/cluster-judge.js";
import type { EmbeddingProvider } from "../src/analysis/embedding-provider.js";
import { MySqlAnalysisRepository } from "../src/analysis/repository.js";
import { CollectionWorker } from "../src/collection/worker.js";
import { MySqlCollectionRepository } from "../src/collection/repository.js";
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
import { SkillCandidateWorker } from "../src/skill/candidate-worker.js";
import { DeterministicSkillGenerator } from "../src/skill/generator.js";
import { MySqlSkillRepository } from "../src/skill/repository.js";
import { SkillRuntime } from "../src/skill/runtime.js";
import { SkillService } from "../src/skill/service.js";
import { SkillValidationWorker } from "../src/skill/validation-worker.js";
import { SkillValidationRunner, ToolValidationExecutor } from "../src/skill/validation.js";
import type { AuthorityChecker } from "../src/skill/types.js";
import { generateL4E2EData, l4E2EGroupLabels, l4E2EGroupOf } from "./fixtures/l4-e2e-data.js";

const databaseUrl = process.env.LINKCLI_TEST_MYSQL_URL;
const realMySqlDescribe = databaseUrl ? describe : describe.skip;
const adminKey = "mysql-l4-e2e-admin-key-at-least-24-chars";
const projectToken = "mysql-l4-e2e-project-token";

async function listen(app: express.Application): Promise<{ url: string; close: () => Promise<void> }> {
  const server = app.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address() as AddressInfo;
  return { url: `http://127.0.0.1:${address.port}`, close: () => new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve())) };
}

async function startDownstream(): Promise<{ endpoint: string; calls: Array<Record<string, unknown>>; close: () => Promise<void> }> {
  const calls: Array<Record<string, unknown>> = [];
  const app = createMcpExpressApp({ host: "127.0.0.1" });
  app.use(express.json());
  app.all("/mcp", async (req: Request, res: Response) => {
    if (req.header("authorization") !== `Bearer ${projectToken}`) { res.status(401).json({ error: "unauthorized" }); return; }
    const server = new Server({ name: "mysql-l4-e2e-downstream", version: "1.0.0" }, { capabilities: { tools: {} } });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [{ name: "echo", description: "Echo a query", inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, outputSchema: { type: "object", properties: { answer: { type: "string" } } } }] }));
    server.setRequestHandler(CallToolRequestSchema, async (request) => {
      const args = (request.params.arguments ?? {}) as Record<string, unknown>;
      calls.push(args);
      const query = String(args.query ?? "");
      return { content: [{ type: "text", text: `echo:${query}` }], structuredContent: { answer: `echo:${query}` } } as never;
    });
    try { await server.connect(transport); await transport.handleRequest(req, res, req.body); }
    finally { await transport.close().catch(() => undefined); await server.close().catch(() => undefined); }
  });
  const running = await listen(app);
  return { endpoint: `${running.url}/mcp`, calls, close: running.close };
}

class E2EEmbedding implements EmbeddingProvider {
  readonly modelVersion = "mysql-l4-e2e-embedding-v1";
  readonly candidateHandoffEnabled = true;
  async embed(texts: string[]): Promise<number[][]> { return texts.map((text) => { const index = Math.max(0, l4E2EGroupLabels.indexOf(l4E2EGroupOf(text))); return l4E2EGroupLabels.map((_label, position) => position === index ? 1 : 0); }); }
}

class E2EJudge implements ClusterJudge {
  readonly modelVersion = "mysql-l4-e2e-judge-v1";
  readonly candidateHandoffEnabled = true;
  async assign(input: Parameters<ClusterJudge["assign"]>[0]) { const label = l4E2EGroupOf(input.query); const target = input.candidates.find((candidate) => candidate.representativeQueries.some((query) => l4E2EGroupOf(query) === label)); return { clusterId: target?.clusterId ?? null, confidence: 1, reason: target ? "same fixture intent" : "new fixture intent" }; }
  async shouldMerge(): Promise<{ sameDemand: false; confidence: number; reason: string }> { return { sameDemand: false, confidence: 1, reason: "fixture groups stay separate" }; }
}

async function reset(pool: Pool): Promise<void> {
  const connection = await pool.getConnection();
  try {
    const [[identity]] = await connection.query<mysql.RowDataPacket[]>("SELECT DATABASE() AS name");
    const name = String(identity?.name ?? "");
    if (!/(?:_dev|_test)$/.test(name)) throw new Error(`Refusing to reset non-test database: ${name}`);
    await connection.query("SET FOREIGN_KEY_CHECKS=0");
    try {
      for (const table of ["mcp_skill_validation_jobs", "mcp_skill_reviews", "mcp_skill_validation_runs", "mcp_skill_versions", "mcp_skills", "mcp_l4_candidate_outbox", "mcp_cluster_score_history", "mcp_query_cluster_scene", "mcp_query_cluster", "mcp_analysis_input", "mcp_analysis_outbox", "mcp_call_events", "mcp_turns", "mcp_call_outbox", "mcp_reviews", "mcp_tool_runtime", "mcp_tool_versions", "mcp_service_versions", "mcp_projects", "mcp_call_credentials"]) await connection.query(`TRUNCATE TABLE \`${table}\``);
    } finally { await connection.query("SET FOREIGN_KEY_CHECKS=1"); }
  } finally { connection.release(); }
}

realMySqlDescribe("real MySQL L3 to L4 end-to-end", () => {
  let pool: Pool;
  beforeAll(() => { pool = mysql.createPool({ uri: databaseUrl!, connectionLimit: 10, timezone: "Z", dateStrings: false }); });
  beforeEach(() => reset(pool), 60_000);
  afterAll(async () => { await reset(pool); await pool.end(); });

  it("persists 480 L3 samples and executes an L4 Skill through real MCP HTTP", async () => {
    const downstream = await startDownstream();
    let linkcli: { url: string; close: () => Promise<void> } | undefined;
    let client: Client | undefined;
    try {
      const registry = new MySqlRegistryRepository(pool, pool);
      const collection = new MySqlCollectionRepository(pool, Buffer.alloc(32, 23));
      const connector = new SdkMcpConnector();
      const cipher = new ProjectCredentialCipher(Buffer.alloc(32, 19).toString("base64"), "mysql-l4-e2e-key");
      const events = new NoopRegistryEventSink();
      const health = new HealthMonitor(registry, connector, cipher, 1, 1, 5_000, events);
      const projects = new ProjectService(registry, new DiscoveryService(connector, 5_000), cipher, events);
      const reviews = new ReviewService(registry, health, events);
      const registered = await projects.register({ projectKey: "mysql-l4-fixture", displayName: "MySQL L4 fixture", description: "Real MySQL L4 dependency", endpoint: downstream.endpoint, projectToken, ownerId: "mysql-l4-owner" });
      await reviews.submit(registered.version.id, "mysql-l4-owner");
      expect((await reviews.decide(registered.version.id, "approved", "mysql-l4-reviewer", "approved")).published).toBe(true);
      const tool = registered.tools[0]!;

      const analysisRepository = new MySqlAnalysisRepository(pool, pool);
      const consumer = new AnalysisInputConsumer(analysisRepository);
      const samples = generateL4E2EData({ projectId: registered.project.id, moduleId: "orders", toolName: tool.originalName, serviceVersionId: registered.version.id, toolVersionId: tool.id });
      expect(samples).toHaveLength(480);
      for (const sample of samples) await consumer.accept(sample);
      const batch = await new AnalysisBatchService(analysisRepository, new E2EEmbedding(), new E2EJudge(), { minimumSamples: 20, minimumActors: 5, minimumSpanMs: 3 * 24 * 60 * 60 * 1_000, minimumInputCompleteness: 1, minimumSuccessRate: 0.9 }, undefined, true).runBatch(1_000, new Date(Date.UTC(2026, 7, 10)));
      expect(batch).toMatchObject({ read: 480, analyzed: 480, failed: 0, candidates: 8 });

      const skillRepository = new MySqlSkillRepository(pool, pool);
      const authority: AuthorityChecker = { async check(_sample, _version, replay) { const matched = JSON.stringify(replay.outputs ?? {}).includes("echo:"); return { verdict: matched ? "passed" : "failed", summary: { source: "mysql-l4-authoritative-fixture", matched } }; } };
      const skillService = new SkillService(skillRepository, new DeterministicSkillGenerator(), new SkillValidationRunner(new ToolValidationExecutor(registry, connector, cipher, 5_000), authority));
      const candidateWorker = new SkillCandidateWorker(analysisRepository, skillService, { batchSize: 100, leaseMs: 30_000, maxAttempts: 3, retryBaseMs: 1 });
      expect(await candidateWorker.drainOnce(new Date())).toMatchObject({ claimed: 8, delivered: 8, failed: 0 });
      const validationWorker = new SkillValidationWorker(skillRepository, skillService, { batchSize: 100, leaseMs: 30_000, maxAttempts: 3, retryBaseMs: 1 });
      expect(await validationWorker.drainOnce(new Date())).toMatchObject({ claimed: 8, completed: 8, failed: 0 });
      for (const skill of await skillService.list()) { expect(skill.status).toBe("pending_review"); await skillService.decideReview(skill.id, "approved", "mysql-l4-reviewer", "validated"); await skillService.lifecycle(skill.id, "activate"); }
      const [[validationRuns]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) AS count FROM mcp_skill_validation_runs WHERE verdict='passed'");
      expect(Number(validationRuns?.count)).toBe(8);

      const credentials = new CredentialService(registry);
      const runtime = new SkillRuntime(skillService, registry, connector, cipher, health, collection, Buffer.alloc(32, 23), 5_000);
      const catalog = new CatalogService(registry, 60_000, runtime);
      const gateway = new GatewayRouter(registry, catalog, connector, cipher, health, collection, Buffer.alloc(32, 23), 5_000);
      linkcli = await listen(createApp({ projects, reviews, health, credentials, catalog, gateway, collection, skills: skillService }, adminKey));
      const issued = await credentials.issue("mysql-l4-agent", "MySQL L4 E2E", null);
      client = new Client({ name: "mysql-l4-e2e-client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${linkcli.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}`, "x-linkcli-session-id": "mysql-l4-e2e" } } }));
      const skill = (await skillService.list())[0]!;
      const result = await client.callTool({ name: `skill__${skill.skillKey}`, arguments: { query: "查询订单最新状态（订单查询-MySQL）", [USER_QUESTION_FIELD]: "查询订单最新状态（订单查询-MySQL）" } });
      expect(JSON.stringify(result)).toContain("echo:");
      expect(downstream.calls).toHaveLength(9);

      const collectionWorker = new CollectionWorker(collection, { idleTimeoutMs: 1, gracePeriodMs: 1, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, { batchSize: 100, leaseMs: 30_000, startedCallTimeoutMs: 120_000, retryBaseMs: 1 });
      expect(await collectionWorker.drainOnce()).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
      const [[event]] = await pool.query<mysql.RowDataPacket[]>("SELECT skill_id,skill_version_id,skill_run_id,skill_step_id,outcome FROM mcp_call_events");
      expect(event).toMatchObject({ skill_id: skill.id, skill_version_id: skill.currentVersionId, skill_step_id: "step-1", outcome: "success" });
      expect(event?.skill_run_id).toEqual(expect.any(String));
    } finally {
      await client?.close().catch(() => undefined);
      await linkcli?.close().catch(() => undefined);
      await downstream.close().catch(() => undefined);
    }
  }, 180_000);
});
