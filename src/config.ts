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
  MCP_CALL_TIMEOUT_MS: z.coerce.number().int().positive().default(30_000),
  HEALTH_FAILURE_THRESHOLD: z.coerce.number().int().positive().default(3),
  HEALTH_RECOVERY_THRESHOLD: z.coerce.number().int().positive().default(2),
  HEALTH_STALE_AFTER_MS: z.coerce.number().int().positive().default(120_000),
  L2_ENDPOINT: z.string().url().optional(),
  L4_EVENT_ENDPOINT: z.string().url().optional(),
  L2_QUEUE_CAPACITY: z.coerce.number().int().positive().default(1_000),
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
  if (["0.0.0.0", "::"].includes(parsed.data.HOST) && !parsed.data.MCP_ALLOWED_HOSTS?.length) {
    throw new Error("Invalid configuration: MCP_ALLOWED_HOSTS is required when HOST binds to all interfaces");
  }
  return parsed.data;
}
