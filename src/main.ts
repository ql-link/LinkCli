import { createPool } from "mysql2/promise";
import { AnalysisBatchScheduler } from "./analysis/batch-scheduler.js";
import { AnalysisBatchService } from "./analysis/batch-service.js";
import { DeterministicFallbackEmbeddingProvider, LocalEmbeddingProvider, RemoteEmbeddingProvider, type EmbeddingProvider } from "./analysis/embedding-provider.js";
import { CodexCliClusterJudge, NewClusterOnlyJudge, RemoteLlmClusterJudge, type ClusterJudge } from "./analysis/cluster-judge.js";
import { AnalysisInputConsumer } from "./analysis/input-consumer.js";
import { AnalysisOutboxWorker } from "./analysis/outbox-worker.js";
import { MySqlAnalysisRepository } from "./analysis/repository.js";
import { ClusterRebuildJob } from "./analysis/rebuild.js";
import { MySqlIdentityRepository } from "./auth/repository.js";
import { IdentityService } from "./auth/service.js";
import { createApp } from "./app.js";
import { MySqlCollectionRepository } from "./collection/repository.js";
import { CollectionWorker, RetentionService } from "./collection/worker.js";
import { loadConfig } from "./config.js";
import { MySqlRegistryRepository } from "./db/repository.js";
import { CredentialService } from "./gateway/auth.js";
import { CatalogService } from "./gateway/catalog.js";
import { GatewayRouter } from "./gateway/router.js";
import { SdkMcpConnector } from "./registry/connector.js";
import { DiscoveryService } from "./registry/discovery.js";
import { HttpRegistryEventSink, NoopRegistryEventSink } from "./registry/events.js";
import { HealthMonitor } from "./registry/health-monitor.js";
import { ProjectService } from "./registry/project-service.js";
import { ReviewService } from "./registry/review-service.js";
import { ProjectCredentialCipher } from "./security/project-credential.js";
import { StatisticsService } from "./statistics/service.js";
import { MySqlSkillRepository } from "./skill/repository.js";
import { SkillService } from "./skill/service.js";
import { SkillCandidateWorker } from "./skill/candidate-worker.js";
import { SkillRuntime } from "./skill/runtime.js";
import { SkillValidationWorker } from "./skill/validation-worker.js";
import { NoopAuthorityChecker, SkillValidationRunner, ToolValidationExecutor } from "./skill/validation.js";

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ uri: config.DATABASE_URL, connectionLimit: 10, timezone: "Z", dateStrings: false });
  await pool.query("SELECT 1");
  const repository = new MySqlRegistryRepository(pool, pool);
  const skillRepository = new MySqlSkillRepository(pool, pool);
  const analysisRepository = new MySqlAnalysisRepository(pool, pool);
  const analysisInputConsumer = new AnalysisInputConsumer(analysisRepository);
  const fingerprintKey = Buffer.from(config.COLLECTION_FINGERPRINT_KEY, "base64");
  const collection = new MySqlCollectionRepository(pool, fingerprintKey);
  const identity = new IdentityService(new MySqlIdentityRepository(pool));
  const connector = new SdkMcpConnector();
  const cipher = new ProjectCredentialCipher(config.PROJECT_CREDENTIAL_KEY, config.PROJECT_CREDENTIAL_KEY_ID);
  const skillService = new SkillService(skillRepository, undefined, new SkillValidationRunner(new ToolValidationExecutor(repository, connector, cipher, config.MCP_CALL_TIMEOUT_MS), new NoopAuthorityChecker()));
  const events = config.L4_EVENT_ENDPOINT ? new HttpRegistryEventSink(config.L4_EVENT_ENDPOINT) : new NoopRegistryEventSink();
  const discovery = new DiscoveryService(connector, config.MCP_CALL_TIMEOUT_MS);
  const health = new HealthMonitor(repository, connector, cipher, config.HEALTH_FAILURE_THRESHOLD, config.HEALTH_RECOVERY_THRESHOLD, config.MCP_CALL_TIMEOUT_MS, events);
  const projects = new ProjectService(repository, discovery, cipher, events);
  const reviews = new ReviewService(repository, health, events);
  const credentials = new CredentialService(repository);
  const collectionSettings = { idleTimeoutMs: config.COLLECTION_IDLE_TIMEOUT_MS, gracePeriodMs: config.COLLECTION_GRACE_PERIOD_MS, lateRevisionMs: config.COLLECTION_LATE_REVISION_MS, maxCallsPerTurn: config.COLLECTION_MAX_CALLS_PER_TURN, maxDeliveryAttempts: config.COLLECTION_MAX_DELIVERY_ATTEMPTS };
  const collectionWorker = new CollectionWorker(collection, collectionSettings, { batchSize: config.COLLECTION_WORKER_BATCH_SIZE, leaseMs: config.COLLECTION_LEASE_MS, startedCallTimeoutMs: config.COLLECTION_STARTED_CALL_TIMEOUT_MS, retryBaseMs: config.COLLECTION_WORKER_INTERVAL_MS });
  const retention = new RetentionService(collection, config.COLLECTION_DETAIL_RETENTION_DAYS, config.COLLECTION_OUTBOX_RETENTION_DAYS);
  const skillRuntime = new SkillRuntime(skillService, repository, connector, cipher, health, collection, fingerprintKey, config.MCP_CALL_TIMEOUT_MS);
  const catalog = new CatalogService(repository, config.HEALTH_STALE_AFTER_MS, skillRuntime);
  const gateway = new GatewayRouter(repository, catalog, connector, cipher, health, collection, fingerprintKey, config.MCP_CALL_TIMEOUT_MS);
  const statistics = new StatisticsService(collection, repository);
  let embeddings: EmbeddingProvider;
  if (config.L3_EMBEDDING_ENDPOINT && config.L3_EMBEDDING_API_KEY && config.L3_EMBEDDING_MODEL && config.L3_EMBEDDING_DIMENSIONS) {
    embeddings = new RemoteEmbeddingProvider({ endpoint: config.L3_EMBEDDING_ENDPOINT, apiKey: config.L3_EMBEDDING_API_KEY, model: config.L3_EMBEDDING_MODEL, dimensions: config.L3_EMBEDDING_DIMENSIONS, timeoutMs: config.MCP_CALL_TIMEOUT_MS });
  } else if (config.L3_LOCAL_EMBEDDING_MODEL && config.L3_LOCAL_EMBEDDING_DIMENSIONS) {
    embeddings = new LocalEmbeddingProvider(config.L3_LOCAL_EMBEDDING_MODEL,config.L3_LOCAL_EMBEDDING_DIMENSIONS,{dtype:config.L3_LOCAL_EMBEDDING_DTYPE,cacheDir:config.L3_LOCAL_EMBEDDING_CACHE_DIR,localFilesOnly:config.L3_LOCAL_EMBEDDING_LOCAL_FILES_ONLY});
  } else {
    console.warn("No semantic L3 embedding provider is configured; falling back to a non-semantic word-ngram provider. Candidates produced under this provider are for shadow evaluation only (see MCPSTAT-1-L3 §16).");
    embeddings = new DeterministicFallbackEmbeddingProvider();
  }
  let clusterJudge: ClusterJudge;
  if (config.L3_JUDGE_PROVIDER==="codex-cli") {
    clusterJudge=new CodexCliClusterJudge({command:config.L3_CODEX_CLI_COMMAND,model:config.L3_CODEX_CLI_MODEL,reasoningEffort:config.L3_CODEX_CLI_REASONING_EFFORT,timeoutMs:config.L3_CODEX_CLI_TIMEOUT_MS});
  } else if (config.L3_JUDGE_PROVIDER==="remote"&&config.L3_LLM_ENDPOINT && config.L3_LLM_API_KEY && config.L3_LLM_MODEL) {
    clusterJudge = new RemoteLlmClusterJudge({endpoint:config.L3_LLM_ENDPOINT,apiKey:config.L3_LLM_API_KEY,model:config.L3_LLM_MODEL,timeoutMs:config.MCP_CALL_TIMEOUT_MS});
  } else {
    console.warn("No L3 LLM cluster judge is configured; L3 will create shadow-only categories and will not merge or hand candidates to L4.");
    clusterJudge = new NewClusterOnlyJudge();
  }
  const analysisThresholds = {
    minimumSamples: config.L3_MINIMUM_SAMPLES,
    minimumActors: config.L3_MINIMUM_ACTORS,
    minimumSpanMs: config.L3_MINIMUM_SPAN_MS,
    minimumInputCompleteness: config.L3_MINIMUM_INPUT_COMPLETENESS,
    minimumCohesion: config.L3_MINIMUM_COHESION,
    minimumSuccessRate: config.L3_MINIMUM_SUCCESS_RATE,
    minimumCoverageGapCount: config.L3_MINIMUM_COVERAGE_GAPS,
    minimumCoverageGapRatio: config.L3_MINIMUM_COVERAGE_GAP_RATIO,
    minimumRebuildMembers: config.L3_MINIMUM_REBUILD_MEMBERS,
  };
  const decisionSettings={recallTopK:config.L3_RECALL_TOP_K,representativeQueryLimit:config.L3_REPRESENTATIVE_QUERY_LIMIT,minimumRecallSimilarity:config.L3_MINIMUM_RECALL_SIMILARITY};
  const analysis = new AnalysisBatchService(analysisRepository,embeddings,clusterJudge,analysisThresholds,undefined,config.L3_CANDIDATE_HANDOFF_ENABLED,decisionSettings);
  const analysisScheduler = new AnalysisBatchScheduler(analysis, config.L3_BATCH_INTERVAL_MS, config.L3_BATCH_SIZE, (error) => console.error("L3 analysis batch failed", error));
  const rebuildJob = new ClusterRebuildJob(analysisRepository,clusterJudge,analysisThresholds,decisionSettings);
  const analysisOutboxWorker = new AnalysisOutboxWorker(pool, analysisInputConsumer, { batchSize:config.COLLECTION_WORKER_BATCH_SIZE,leaseMs:config.COLLECTION_LEASE_MS,maxAttempts:config.COLLECTION_MAX_DELIVERY_ATTEMPTS,retryBaseMs:config.COLLECTION_WORKER_INTERVAL_MS });
  const skillCandidateWorker = new SkillCandidateWorker(analysisRepository, skillService, { batchSize: config.COLLECTION_WORKER_BATCH_SIZE, leaseMs: config.COLLECTION_LEASE_MS, maxAttempts: config.COLLECTION_MAX_DELIVERY_ATTEMPTS, retryBaseMs: config.COLLECTION_WORKER_INTERVAL_MS });
  const skillValidationWorker = new SkillValidationWorker(skillRepository, skillService, { batchSize: config.COLLECTION_WORKER_BATCH_SIZE, leaseMs: config.COLLECTION_LEASE_MS, maxAttempts: config.COLLECTION_MAX_DELIVERY_ATTEMPTS, retryBaseMs: config.COLLECTION_WORKER_INTERVAL_MS });
  const app = createApp(
    { projects, reviews, health, credentials, catalog, gateway, collection, skills: skillService }, config.ADMIN_API_KEY, config.HOST, config.MCP_ALLOWED_HOSTS,
    { identity, repository, projects, reviews, health, credentials, statistics, analysis: analysisRepository, skills: skillService }, config.WEB_DIST_DIR, config.NODE_ENV === "production",
  );
  const server = app.listen(config.PORT, config.HOST, () => { console.info(`LinkCli listening on http://${config.HOST}:${config.PORT}`); });
  const healthTimer = setInterval(() => { void health.probeActiveProjects(); void health.emitStaleAlerts(); }, Math.min(config.HEALTH_STALE_AFTER_MS / 2, 30_000));
  healthTimer.unref();
  if (config.L3_BATCH_ENABLED) analysisScheduler.start();
  const rebuildTimer = setInterval(() => { void rebuildJob.runOnce().catch((error) => console.error("L3 cluster rebuild failed", error)); }, config.L3_REBUILD_INTERVAL_MS);
  rebuildTimer.unref();
  let collectionTask: Promise<void> | null = null;
  const collectionTimer = setInterval(() => {
    if (collectionTask) return;
    collectionTask = collectionWorker.drainOnce().then(() => collectionWorker.maintainOnce()).then(() => analysisOutboxWorker.drainOnce()).then(() => skillCandidateWorker.drainOnce()).then(() => skillValidationWorker.drainOnce()).then(() => undefined).catch(() => { console.error("Collection worker cycle failed"); }).finally(() => { collectionTask = null; });
  }, config.COLLECTION_WORKER_INTERVAL_MS);
  collectionTimer.unref();
  const retentionTimer = setInterval(() => { void retention.runOnce().catch(() => { console.error("Collection retention cycle failed"); }); }, 24 * 60 * 60 * 1_000);
  retentionTimer.unref();
  let shuttingDown = false;
  const shutdown = async (): Promise<void> => {
    if (shuttingDown) return; shuttingDown = true;
    clearInterval(healthTimer); clearInterval(collectionTimer); clearInterval(retentionTimer); clearInterval(rebuildTimer);
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await analysisScheduler.stop(); await collectionTask; await pool.end();
  };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "LinkCli startup failed"); process.exitCode = 1; });
