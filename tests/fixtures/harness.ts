import type { DiscoveryResult, DiscoveredTool, JsonObject } from "../../src/domain.js";
import { BoundedDispatcher, type EnvelopeSink } from "../../src/collection/dispatcher.js";
import type { CallEnvelope } from "../../src/collection/envelope.js";
import { MemoryRegistryRepository } from "../../src/db/repository.js";
import { CredentialService } from "../../src/gateway/auth.js";
import { CatalogService } from "../../src/gateway/catalog.js";
import { GatewayRouter } from "../../src/gateway/router.js";
import type { McpConnector, ToolCallResult } from "../../src/registry/connector.js";
import { DiscoveryService } from "../../src/registry/discovery.js";
import type { RegistryEvent, RegistryEventSink } from "../../src/registry/events.js";
import { HealthMonitor } from "../../src/registry/health-monitor.js";
import { ProjectService } from "../../src/registry/project-service.js";
import { ReviewService } from "../../src/registry/review-service.js";
import { ProjectCredentialCipher } from "../../src/security/project-credential.js";

export const testKey = Buffer.alloc(32, 7).toString("base64");
export const searchTool = (description = "搜索内部资料"): DiscoveredTool => ({ name: "search", description, inputSchema: { type: "object", properties: { query: { type: "string" } }, required: ["query"] }, outputSchema: { type: "object", properties: { answer: { type: "string" } } } });

interface EndpointState { token: string | null; discovery: DiscoveryResult; healthy: boolean; result: ToolCallResult; error?: Error; calls: Array<{ name: string; arguments: JsonObject; token: string | null }>; }

export class FakeMcpConnector implements McpConnector {
  readonly endpoints = new Map<string, EndpointState>();
  add(endpoint: string, tools: DiscoveredTool[], token: string | null = "project-token"): EndpointState {
    const state: EndpointState = { token, discovery: { protocolVersion: "2025-11-25", tools }, healthy: true, result: { content: [{ type: "text", text: "ok" }], structuredContent: { answer: "ok" } }, calls: [] };
    this.endpoints.set(endpoint, state); return state;
  }
  private get(endpoint: string, token: string | null): EndpointState {
    const state = this.endpoints.get(endpoint); if (!state) throw new Error("connection failed");
    if (state.token !== token) throw new Error("401 unauthorized"); return state;
  }
  async discover(endpoint: string, token: string | null): Promise<DiscoveryResult> { return structuredClone(this.get(endpoint, token).discovery); }
  async probe(endpoint: string, token: string | null): Promise<boolean> { const state = this.get(endpoint, token); if (!state.healthy) throw new Error("unhealthy"); return true; }
  async callTool(endpoint: string, token: string | null, name: string, arguments_: JsonObject, _timeoutMs: number): Promise<ToolCallResult> {
    const state = this.get(endpoint, token); state.calls.push({ name, arguments: structuredClone(arguments_), token }); if (state.error) throw state.error; return structuredClone(state.result);
  }
}

export class CapturingEvents implements RegistryEventSink {
  readonly events: RegistryEvent[] = [];
  fail = false;
  async publish(event: RegistryEvent): Promise<void> { if (this.fail) throw new Error("event webhook unavailable"); this.events.push(event); }
}
export class CapturingEnvelopeSink implements EnvelopeSink { readonly envelopes: CallEnvelope[] = []; fail = false; async send(envelope: CallEnvelope): Promise<void> { if (this.fail) throw new Error("L2 unavailable"); this.envelopes.push(envelope); } }

export function createHarness(options: { failureThreshold?: number; recoveryThreshold?: number; staleAfterMs?: number } = {}) {
  const repository = new MemoryRegistryRepository(); const connector = new FakeMcpConnector(); const events = new CapturingEvents(); const sink = new CapturingEnvelopeSink();
  const cipher = new ProjectCredentialCipher(testKey, "test-key");
  const discovery = new DiscoveryService(connector, 1000);
  const health = new HealthMonitor(repository, connector, cipher, options.failureThreshold ?? 1, options.recoveryThreshold ?? 1, 1000, events);
  const projects = new ProjectService(repository, discovery, cipher, events);
  const reviews = new ReviewService(repository, health, events);
  const credentials = new CredentialService(repository);
  const catalog = new CatalogService(repository, options.staleAfterMs ?? 60_000);
  const dispatcher = new BoundedDispatcher(sink, 10);
  const gateway = new GatewayRouter(repository, catalog, connector, cipher, health, dispatcher, 1000);
  return { repository, connector, events, sink, cipher, discovery, health, projects, reviews, credentials, catalog, dispatcher, gateway };
}

export async function registerSubmitted(harness: ReturnType<typeof createHarness>, endpoint = "http://project.test/mcp", key = "knowledge") {
  harness.connector.add(endpoint, [searchTool()]);
  const registered = await harness.projects.register({ projectKey: key, displayName: "知识项目", description: "企业内部知识检索", endpoint, projectToken: "project-token", ownerId: "owner-1" });
  await harness.reviews.submit(registered.version.id, "owner-1");
  return registered;
}

export async function approve(harness: ReturnType<typeof createHarness>, versionId: string) {
  return harness.reviews.decide(versionId, "approved", "reviewer-1", "审核通过");
}
