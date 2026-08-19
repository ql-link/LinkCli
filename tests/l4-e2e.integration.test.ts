import { once } from "node:events";
import type { AddressInfo } from "node:net";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import express, { type Request, type Response } from "express";
import { describe, expect, it } from "vitest";
import { createApp } from "../src/app.js";
import { AnalysisBatchService } from "../src/analysis/batch-service.js";
import { AnalysisInputConsumer } from "../src/analysis/input-consumer.js";
import { MemoryAnalysisRepository } from "../src/analysis/repository.js";
import type { EmbeddingProvider } from "../src/analysis/embedding-provider.js";
import type { ClusterJudge } from "../src/analysis/cluster-judge.js";
import { MemoryCollectionRepository } from "../src/collection/repository.js";
import { CollectionWorker } from "../src/collection/worker.js";
import { MemoryRegistryRepository } from "../src/db/repository.js";
import { CredentialService } from "../src/gateway/auth.js";
import { CatalogService, USER_QUESTION_FIELD } from "../src/gateway/catalog.js";
import { GatewayRouter } from "../src/gateway/router.js";
import { DiscoveryService } from "../src/registry/discovery.js";
import { SdkMcpConnector } from "../src/registry/connector.js";
import { NoopRegistryEventSink } from "../src/registry/events.js";
import { HealthMonitor } from "../src/registry/health-monitor.js";
import { ProjectService } from "../src/registry/project-service.js";
import { ReviewService } from "../src/registry/review-service.js";
import { ProjectCredentialCipher } from "../src/security/project-credential.js";
import { SkillCandidateWorker } from "../src/skill/candidate-worker.js";
import { DeterministicSkillGenerator } from "../src/skill/generator.js";
import { MemorySkillRepository } from "../src/skill/repository.js";
import { SkillRuntime } from "../src/skill/runtime.js";
import { SkillService } from "../src/skill/service.js";
import { SkillValidationWorker } from "../src/skill/validation-worker.js";
import { ToolValidationExecutor, SkillValidationRunner } from "../src/skill/validation.js";
import type { AuthorityChecker } from "../src/skill/types.js";
import { generateL4E2EData, l4E2EGroupOf, l4E2EGroupLabels } from "./fixtures/l4-e2e-data.js";

const adminKey = "l4-e2e-admin-key-at-least-24-characters";
const projectToken = "l4-e2e-project-token";
const projectKey = "l4e-fixture";

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
    const server = new Server({ name: "l4-e2e-downstream", version: "1.0.0" }, { capabilities: { tools: {} } });
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

class L4E2EEmbedding implements EmbeddingProvider {
  readonly modelVersion = "l4-e2e-embedding-v1";
  readonly candidateHandoffEnabled = true;
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => {
      const index = Math.max(0, l4E2EGroupLabels.indexOf(l4E2EGroupOf(text)));
      return l4E2EGroupLabels.map((_label, position) => position === index ? 1 : 0);
    });
  }
}

class L4E2EJudge implements ClusterJudge {
  readonly modelVersion = "l4-e2e-judge-v1";
  readonly candidateHandoffEnabled = true;
  async assign(input: Parameters<ClusterJudge["assign"]>[0]) {
    const label = l4E2EGroupOf(input.query);
    const target = input.candidates.find((candidate) => candidate.representativeQueries.some((query) => l4E2EGroupOf(query) === label));
    return { clusterId: target?.clusterId ?? null, confidence: 1, reason: target ? "same generated fixture intent" : "new generated fixture intent" };
  }
  async shouldMerge(): Promise<{ sameDemand: false; confidence: number; reason: string }> { return { sameDemand: false, confidence: 1, reason: "fixture groups stay separate" }; }
}

describe("L4 complete local HTTP end-to-end", () => {
  it("generates 480 L3 records and drives candidate, validation, review, activation, MCP call and L2 collection", async () => {
    const downstream = await startDownstream();
    let linkcli: { url: string; close: () => Promise<void> } | undefined;
    let client: Client | undefined;
    try {
      const repository = new MemoryRegistryRepository();
      const collection = new MemoryCollectionRepository();
      const connector = new SdkMcpConnector();
      const cipher = new ProjectCredentialCipher(Buffer.alloc(32, 19).toString("base64"), "l4-e2e-key");
      const events = new NoopRegistryEventSink();
      const health = new HealthMonitor(repository, connector, cipher, 1, 1, 5_000, events);
      const projects = new ProjectService(repository, new DiscoveryService(connector, 5_000), cipher, events);
      const reviews = new ReviewService(repository, health, events);
      const registered = await projects.register({ projectKey, displayName: "L4 E2E fixture", description: "Real local Streamable HTTP dependency", endpoint: downstream.endpoint, projectToken, ownerId: "l4-owner" });
      await reviews.submit(registered.version.id, "l4-owner");
      const publication = await reviews.decide(registered.version.id, "approved", "l4-reviewer", "local real MCP fixture approved");
      expect(publication.published).toBe(true);
      const activeProject = await repository.getProjectById(registered.project.id);
      const activeVersion = await repository.getVersion(registered.version.id);
      const echoTool = registered.tools[0]!;
      expect(activeProject?.status).toBe("active");
      expect(activeProject?.activeVersionId).toBe(activeVersion?.id);

      const analysisRepository = new MemoryAnalysisRepository();
      const consumer = new AnalysisInputConsumer(analysisRepository);
      const samples = generateL4E2EData({ projectId: registered.project.id, moduleId: "orders", toolName: echoTool.originalName, serviceVersionId: registered.version.id, toolVersionId: echoTool.id });
      expect(samples).toHaveLength(480);
      for (const sample of samples) expect(await consumer.accept(sample)).toBe(true);
      const analysis = new AnalysisBatchService(analysisRepository, new L4E2EEmbedding(), new L4E2EJudge(), { minimumSamples: 20, minimumActors: 5, minimumSpanMs: 3 * 24 * 60 * 60 * 1_000, minimumInputCompleteness: 1, minimumSuccessRate: 0.9 }, undefined, true);
      const batch = await analysis.runBatch(1_000, new Date(Date.UTC(2026, 7, 10)));
      expect(batch).toMatchObject({ read: 480, analyzed: 480, failed: 0, candidates: 8 });
      const candidateEvents = await analysisRepository.listOutbox();
      expect(candidateEvents).toHaveLength(8);
      expect(candidateEvents.every((event) => Array.isArray(event.payload.toolPath) && (event.payload.toolPath as Array<Record<string, unknown>>)[0]?.serviceVersionId === registered.version.id)).toBe(true);

      const skillRepository = new MemorySkillRepository();
      const authority: AuthorityChecker = { async check(_sample, _version, replay) { const outputs = replay.outputs; const matched = Boolean(outputs && typeof outputs === "object" && Object.values(outputs as Record<string, unknown>).some((value) => JSON.stringify(value).includes("echo:"))); return { verdict: matched ? "passed" : "failed", summary: { source: "local-authoritative-fixture", matched } }; } };
      const skillService = new SkillService(skillRepository, new DeterministicSkillGenerator(), new SkillValidationRunner(new ToolValidationExecutor(repository, connector, cipher, 5_000), authority));
      const candidateWorker = new SkillCandidateWorker(analysisRepository, skillService, { batchSize: 100, leaseMs: 30_000, maxAttempts: 3, retryBaseMs: 1 });
      expect(await candidateWorker.drainOnce(new Date())).toMatchObject({ claimed: 8, delivered: 8, failed: 0 });
      const skills = await skillService.list();
      expect(skills).toHaveLength(8);
      expect(skills.every((skill) => skill.status === "draft")).toBe(true);

      const validationWorker = new SkillValidationWorker(skillRepository, skillService, { batchSize: 100, leaseMs: 30_000, maxAttempts: 3, retryBaseMs: 1 });
      expect(await validationWorker.drainOnce(new Date())).toMatchObject({ claimed: 8, completed: 8, failed: 0 });
      for (const skill of await skillService.list()) expect((await skillService.get(skill.id)).status).toBe("pending_review");
      for (const skill of await skillService.list()) { await skillService.decideReview(skill.id, "approved", "l4-reviewer", "validation passed"); await skillService.lifecycle(skill.id, "activate"); }

      const runtime = new SkillRuntime(skillService, repository, connector, cipher, health, collection, Buffer.alloc(32, 23), 5_000);
      const catalog = new CatalogService(repository, 60_000, runtime);
      const gateway = new GatewayRouter(repository, catalog, connector, cipher, health, collection, Buffer.alloc(32, 23), 5_000);
      const credentials = new CredentialService(repository);
      linkcli = await listen(createApp({ projects, reviews, health, credentials, catalog, gateway, collection, skills: skillService }, adminKey));
      const issued = await credentials.issue("l4-agent", "L4 E2E credential", null);
      client = new Client({ name: "l4-e2e-client", version: "1.0.0" });
      await client.connect(new StreamableHTTPClientTransport(new URL(`${linkcli.url}/mcp`), { requestInit: { headers: { Authorization: `Bearer ${issued.token}`, "x-linkcli-session-id": "l4-e2e-session" } } }));
      const tools = await client.listTools();
      expect(tools.tools.filter((tool) => tool.name.startsWith("skill__")).length).toBe(8);
      const skill = (await skillService.list())[0]!;
      const call = await client.callTool({ name: `skill__${skill.skillKey}`, arguments: { query: "查询订单最新状态（订单查询-运行样本）", [USER_QUESTION_FIELD]: "查询订单最新状态（订单查询-运行样本）" } });
      expect(JSON.stringify(call)).toContain("echo:");
      expect(downstream.calls).toHaveLength(9);
      expect(downstream.calls.at(-1)).toMatchObject({ query: "查询订单最新状态（订单查询-运行样本）" });

      const collectionWorker = new CollectionWorker(collection, { idleTimeoutMs: 1, gracePeriodMs: 1, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, { batchSize: 100, leaseMs: 30_000, startedCallTimeoutMs: 120_000, retryBaseMs: 1 });
      expect(await collectionWorker.drainOnce()).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
      const callEvents = await collection.listCallEvents();
      expect(callEvents).toHaveLength(1);
      expect(callEvents[0]).toMatchObject({ projectId: registered.project.id, serviceVersionId: registered.version.id, toolVersionId: echoTool.id, skillId: skill.id, skillVersionId: skill.currentVersionId, skillStepId: "step-1", outcome: "success" });
      expect(callEvents[0]?.skillRunId).toEqual(expect.any(String));
      await collection.advanceTurnLifecycles({ idleTimeoutMs: 1, gracePeriodMs: 1, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, new Date(Date.now() + 10));
      await collection.advanceTurnLifecycles({ idleTimeoutMs: 1, gracePeriodMs: 1, lateRevisionMs: 86_400_000, maxCallsPerTurn: 100, maxDeliveryAttempts: 3 }, new Date(Date.now() + 20));
      expect(await collection.settleReadyTurns(new Date(Date.now() + 30), 100)).toBe(1);
      expect((await collection.listTurns())[0]?.settlementStatus).toBe("succeeded");
    } finally {
      await client?.close().catch(() => undefined);
      await linkcli?.close().catch(() => undefined);
      await downstream.close().catch(() => undefined);
    }
  }, 120_000);
});
