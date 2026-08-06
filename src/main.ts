import { createPool } from "mysql2/promise";
import { createApp } from "./app.js";
import { BoundedDispatcher, HttpEnvelopeSink, NoopEnvelopeSink } from "./collection/dispatcher.js";
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

async function main(): Promise<void> {
  const config = loadConfig();
  const pool = createPool({ uri: config.DATABASE_URL, connectionLimit: 10, timezone: "Z", dateStrings: false });
  await pool.query("SELECT 1");
  const repository = new MySqlRegistryRepository(pool, pool);
  const connector = new SdkMcpConnector();
  const cipher = new ProjectCredentialCipher(config.PROJECT_CREDENTIAL_KEY, config.PROJECT_CREDENTIAL_KEY_ID);
  const events = config.L4_EVENT_ENDPOINT ? new HttpRegistryEventSink(config.L4_EVENT_ENDPOINT) : new NoopRegistryEventSink();
  const discovery = new DiscoveryService(connector, config.MCP_CALL_TIMEOUT_MS);
  const health = new HealthMonitor(repository, connector, cipher, config.HEALTH_FAILURE_THRESHOLD, config.HEALTH_RECOVERY_THRESHOLD, config.MCP_CALL_TIMEOUT_MS, events);
  const projects = new ProjectService(repository, discovery, cipher, events);
  const reviews = new ReviewService(repository, health, events);
  const credentials = new CredentialService(repository);
  const catalog = new CatalogService(repository, config.HEALTH_STALE_AFTER_MS);
  const sink = config.L2_ENDPOINT ? new HttpEnvelopeSink(config.L2_ENDPOINT) : new NoopEnvelopeSink();
  const dispatcher = new BoundedDispatcher(sink, config.L2_QUEUE_CAPACITY);
  const gateway = new GatewayRouter(repository, catalog, connector, cipher, health, dispatcher, config.MCP_CALL_TIMEOUT_MS);
  const app = createApp({ projects, reviews, health, credentials, catalog, gateway }, config.ADMIN_API_KEY, config.HOST, config.MCP_ALLOWED_HOSTS);
  const server = app.listen(config.PORT, config.HOST, () => { console.info(`LinkCli listening on http://${config.HOST}:${config.PORT}`); });
  const healthTimer = setInterval(() => { void health.probeActiveProjects(); void health.emitStaleAlerts(); }, Math.min(config.HEALTH_STALE_AFTER_MS / 2, 30_000));
  healthTimer.unref();
  const shutdown = async (): Promise<void> => { clearInterval(healthTimer); server.close(); await dispatcher.idle(); await pool.end(); };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
}

void main().catch((error) => { console.error(error instanceof Error ? error.message : "LinkCli startup failed"); process.exitCode = 1; });
