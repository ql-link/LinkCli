import { z } from "zod";

const schema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().min(1).default("127.0.0.1"),
  MCP_ALLOWED_HOSTS: z.string().optional().transform((value) => value?.split(",").map((item) => item.trim()).filter(Boolean)),
  PORT: z.coerce.number().int().min(1).max(65_535).default(3000),
  DATABASE_URL: z.string().min(1),
  ADMIN_API_KEY: z.string().min(24),
  PROJECT_CREDENTIAL_KEY: z.string().min(1),
  PROJECT_CREDENTIAL_KEY_ID: z.string().min(1).default("v1"),
  COLLECTION_FINGERPRINT_KEY: z.string().min(1),
  MCP_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  HEALTH_RECOVERY_THRESHOLD: z.coerce.number().int().positive().default(2),
  HEALTH_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  L4_EVENT_ENDPOINT: z.string().url().optional(),
  L3_BATCH_ENABLED: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  L3_BATCH_INTERVAL_MS: z.coerce.number().int().min(1_000).default(300_000),
  L3_BATCH_SIZE: z.coerce.number().int().min(1).max(10_000).default(1_000),
  L3_MINIMUM_SAMPLES: z.coerce.number().int().positive().default(20),
  L3_MINIMUM_ACTORS: z.coerce.number().int().positive().default(5),
  L3_MINIMUM_SPAN_MS: z.coerce.number().int().nonnegative().default(259_200_000),
  L3_MINIMUM_INPUT_COMPLETENESS: z.coerce.number().min(0).max(1).default(0.95),
  L3_MINIMUM_COHESION: z.coerce.number().min(0).max(1).default(0.82),
  L3_MINIMUM_SUCCESS_RATE: z.coerce.number().min(0).max(1).default(0.9),
  L3_MINIMUM_COVERAGE_GAPS: z.coerce.number().int().positive().default(5),
  L3_MINIMUM_COVERAGE_GAP_RATIO: z.coerce.number().min(0).max(1).default(0.2),
  L3_RECALL_TOP_K: z.coerce.number().int().min(1).max(20).default(5),
  L3_REPRESENTATIVE_QUERY_LIMIT: z.coerce.number().int().min(1).max(10).default(3),
  L3_MINIMUM_RECALL_SIMILARITY: z.coerce.number().min(-1).max(1).default(0),
  L3_MINIMUM_REBUILD_MEMBERS: z.coerce.number().int().positive().default(3),
  L3_REBUILD_INTERVAL_MS: z.coerce.number().int().min(1_000).default(1_800_000),
  L3_CANDIDATE_HANDOFF_ENABLED: z.enum(["true", "false"]).default("false").transform((value) => value === "true"),
  L3_EMBEDDING_ENDPOINT: z.string().url().optional(),
  L3_EMBEDDING_API_KEY: z.string().optional(),
  L3_EMBEDDING_MODEL: z.string().optional(),
  L3_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  L3_LOCAL_EMBEDDING_MODEL: z.string().optional(),
  L3_LOCAL_EMBEDDING_DIMENSIONS: z.coerce.number().int().positive().optional(),
  L3_LOCAL_EMBEDDING_DTYPE: z.enum(["auto","fp32","fp16","q8","int8","uint8","q4","bnb4","q4f16"]).default("q8"),
  L3_LOCAL_EMBEDDING_CACHE_DIR: z.string().optional(),
  L3_LOCAL_EMBEDDING_LOCAL_FILES_ONLY: z.enum(["true", "false"]).default("true").transform((value) => value === "true"),
  L3_JUDGE_PROVIDER: z.enum(["shadow","remote","codex-cli"]).default("shadow"),
  L3_LLM_ENDPOINT: z.string().url().optional(),
  L3_LLM_API_KEY: z.string().min(1).optional(),
  L3_LLM_MODEL: z.string().min(1).optional(),
  L3_CODEX_CLI_COMMAND: z.string().min(1).default("codex"),
  L3_CODEX_CLI_MODEL: z.string().min(1).default("gpt-5.3-codex-spark"),
  L3_CODEX_CLI_REASONING_EFFORT: z.enum(["low","medium","high","xhigh"]).default("medium"),
  L3_CODEX_CLI_TIMEOUT_MS: z.coerce.number().int().min(1_000).default(60_000),
  COLLECTION_IDLE_TIMEOUT_MS: z.coerce.number().int().positive().default(300_000),
  COLLECTION_GRACE_PERIOD_MS: z.coerce.number().int().positive().default(60_000),
  COLLECTION_LATE_REVISION_MS: z.coerce.number().int().positive().default(86_400_000),
  COLLECTION_MAX_CALLS_PER_TURN: z.coerce.number().int().positive().max(10_000).default(100),
  COLLECTION_WORKER_INTERVAL_MS: z.coerce.number().int().positive().default(1_000),
  COLLECTION_WORKER_BATCH_SIZE: z.coerce.number().int().positive().max(1_000).default(100),
  COLLECTION_LEASE_MS: z.coerce.number().int().positive().default(30_000),
  COLLECTION_MAX_DELIVERY_ATTEMPTS: z.coerce.number().int().positive().default(10),
  COLLECTION_STARTED_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  COLLECTION_DETAIL_RETENTION_DAYS: z.coerce.number().int().positive().default(90),
  COLLECTION_OUTBOX_RETENTION_DAYS: z.coerce.number().int().positive().default(7),
  WEB_DIST_DIR: z.string().min(1).default("web/dist"),
});

export type AppConfig = z.infer<typeof schema>;

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): AppConfig {
  const parsed = schema.safeParse(environment);
  if (!parsed.success) {
    const summary = parsed.error.issues.map((issue) => `${issue.path.join(".")}: ${issue.message}`).join("; ");
    throw new Error(`Invalid configuration: ${summary}`);
  }
  const key = Buffer.from(parsed.data.PROJECT_CREDENTIAL_KEY, "base64");
  if (key.length !== 32) {
    throw new Error("Invalid configuration: PROJECT_CREDENTIAL_KEY must be a base64 encoded 32-byte key");
  }
  const fingerprintKey = Buffer.from(parsed.data.COLLECTION_FINGERPRINT_KEY, "base64");
  if (fingerprintKey.length !== 32) {
    throw new Error("Invalid configuration: COLLECTION_FINGERPRINT_KEY must be a base64 encoded 32-byte key");
  }
  if (fingerprintKey.equals(key)) {
    throw new Error("Invalid configuration: COLLECTION_FINGERPRINT_KEY must be independent from PROJECT_CREDENTIAL_KEY");
  }
  if (parsed.data.COLLECTION_STARTED_CALL_TIMEOUT_MS <= parsed.data.MCP_CALL_TIMEOUT_MS) {
    throw new Error("Invalid configuration: COLLECTION_STARTED_CALL_TIMEOUT_MS must be greater than MCP_CALL_TIMEOUT_MS");
  }
  if (parsed.data.COLLECTION_LATE_REVISION_MS < parsed.data.COLLECTION_GRACE_PERIOD_MS) {
    throw new Error("Invalid configuration: COLLECTION_LATE_REVISION_MS must be at least COLLECTION_GRACE_PERIOD_MS");
  }
  if (["0.0.0.0", "::"].includes(parsed.data.HOST) && !parsed.data.MCP_ALLOWED_HOSTS?.length) {
    throw new Error("Invalid configuration: MCP_ALLOWED_HOSTS is required when HOST binds to all interfaces");
  }
  const remoteEmbeddingSettings = [parsed.data.L3_EMBEDDING_ENDPOINT,parsed.data.L3_EMBEDDING_API_KEY,parsed.data.L3_EMBEDDING_MODEL,parsed.data.L3_EMBEDDING_DIMENSIONS];
  const configuredRemoteSettings = remoteEmbeddingSettings.filter((value) => value !== undefined).length;
  if (configuredRemoteSettings > 0 && configuredRemoteSettings < remoteEmbeddingSettings.length) {
    throw new Error("Invalid configuration: L3_EMBEDDING_ENDPOINT, L3_EMBEDDING_API_KEY, L3_EMBEDDING_MODEL and L3_EMBEDDING_DIMENSIONS must be configured together");
  }
  const localEmbeddingSettings = [parsed.data.L3_LOCAL_EMBEDDING_MODEL,parsed.data.L3_LOCAL_EMBEDDING_DIMENSIONS];
  const configuredLocalSettings = localEmbeddingSettings.filter((value) => value !== undefined).length;
  if (configuredLocalSettings > 0 && configuredLocalSettings < localEmbeddingSettings.length) {
    throw new Error("Invalid configuration: L3_LOCAL_EMBEDDING_MODEL and L3_LOCAL_EMBEDDING_DIMENSIONS must be configured together");
  }
  const hasRemoteEmbedding = configuredRemoteSettings === remoteEmbeddingSettings.length;
  const hasLocalEmbedding = configuredLocalSettings === localEmbeddingSettings.length;
  if (hasRemoteEmbedding && hasLocalEmbedding) {
    throw new Error("Invalid configuration: configure either remote or local L3 embedding, not both");
  }
  const llmSettings = [parsed.data.L3_LLM_ENDPOINT,parsed.data.L3_LLM_API_KEY,parsed.data.L3_LLM_MODEL];
  const configuredLlmSettings = llmSettings.filter((value) => value !== undefined).length;
  if (configuredLlmSettings > 0 && configuredLlmSettings < llmSettings.length) {
    throw new Error("Invalid configuration: L3_LLM_ENDPOINT, L3_LLM_API_KEY and L3_LLM_MODEL must be configured together");
  }
  const hasLlmJudge = configuredLlmSettings === llmSettings.length;
  if(parsed.data.L3_JUDGE_PROVIDER==="remote"&&!hasLlmJudge){
    throw new Error("Invalid configuration: remote L3 judge requires L3_LLM_ENDPOINT, L3_LLM_API_KEY and L3_LLM_MODEL");
  }
  const hasConfiguredJudge=parsed.data.L3_JUDGE_PROVIDER==="codex-cli"||(parsed.data.L3_JUDGE_PROVIDER==="remote"&&hasLlmJudge);
  if (parsed.data.L3_CANDIDATE_HANDOFF_ENABLED && ((!hasRemoteEmbedding && !hasLocalEmbedding) || !hasConfiguredJudge)) {
    throw new Error("Invalid configuration: L3 candidate handoff requires complete embedding and LLM judge configurations");
  }
  return parsed.data;
}
