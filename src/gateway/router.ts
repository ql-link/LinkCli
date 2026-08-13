import type { CatalogEntry, JsonObject, TransportSessionSource } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";
import type { ProjectCredentialCipher } from "../security/project-credential.js";
import type { CollectionRepository } from "../collection/repository.js";
import { createEventId, summarize } from "../collection/envelope.js";
import { resolveAttribution } from "../collection/context.js";
import type { McpConnector, ToolCallResult } from "../registry/connector.js";
import type { HealthMonitor } from "../registry/health-monitor.js";
import { CatalogService, USER_QUESTION_FIELD } from "./catalog.js";

export interface CallContext {
  platformOwnerId: string;
  credentialId: string;
  transportSessionId: string | null;
  transportSessionSource?: TransportSessionSource;
  meta?: Record<string, unknown>;
}

export class GatewayRouter {
  constructor(
    private readonly repository: RegistryRepository,
    private readonly catalog: CatalogService,
    private readonly connector: McpConnector,
    private readonly cipher: ProjectCredentialCipher,
    private readonly health: HealthMonitor,
    private readonly collection: CollectionRepository,
    private readonly fingerprintKey: Buffer,
    private readonly timeoutMs: number,
  ) {}

  async call(publicName: string, arguments_: JsonObject, context: CallContext): Promise<ToolCallResult> {
    const credentialId = context.credentialId;
    const transportSessionId = context.transportSessionId;
    const attribution = resolveAttribution({ credentialId, transportSessionId, transportSessionSource: context.transportSessionSource, arguments: arguments_, meta: context.meta, fingerprintKey: this.fingerprintKey });
    const entry = await this.resolve(publicName);
    const businessArguments = { ...arguments_ }; delete businessArguments[USER_QUESTION_FIELD];
    const token = this.cipher.decrypt(entry.version.credentialCiphertext);
    const eventId = createEventId();
    const startedAt = new Date();
    try {
      await this.collection.beginCall({ id: eventId, platformOwnerId: context.platformOwnerId, credentialId, projectId: entry.project.id, serviceVersionId: entry.version.id, toolVersionId: entry.tool.id,
        projectKey: entry.project.projectKey, toolName: entry.tool.originalName, argumentsSummary: summarize(businessArguments), attribution, startedAt });
    } catch {
      throw new AppError("COLLECTION_UNAVAILABLE", "Call collection is temporarily unavailable", 503);
    }
    let result: ToolCallResult;
    try {
      result = await this.connector.callTool(entry.version.endpoint, token, entry.tool.originalName, businessArguments, this.timeoutMs);
    } catch (error) {
      const completedAt = new Date();
      const safeError = error instanceof AppError ? { code: error.code, message: error.message } : { code: "DOWNSTREAM_PROTOCOL_ERROR", message: "Downstream MCP error" };
      try {
        await this.collection.completeCall(eventId, { resultSummary: summarize(safeError), outcome: "error", errorCode: safeError.code, completedAt, durationMs: completedAt.getTime() - startedAt.getTime() });
      } catch {
        await this.collection.markCallPartial(eventId, "COLLECTION_COMPLETION_WRITE_FAILED", completedAt).catch(() => undefined);
      }
      await this.health.recordCallResult(entry.project.id, false).catch(() => undefined);
      throw error;
    }
    const completedAt = new Date();
    try {
      await this.collection.completeCall(eventId, { resultSummary: summarize(result), outcome: result.isError ? "error" : "success", errorCode: result.isError ? "DOWNSTREAM_TOOL_ERROR" : null, completedAt, durationMs: completedAt.getTime() - startedAt.getTime() });
    } catch {
      await this.collection.markCallPartial(eventId, "COLLECTION_COMPLETION_WRITE_FAILED", completedAt).catch(() => undefined);
    }
    await this.health.recordCallResult(entry.project.id, !result.isError).catch(() => undefined);
    return result;
  }

  private async resolve(publicName: string): Promise<CatalogEntry> {
    const current = (await this.catalog.entries()).find((entry) => entry.publicName === publicName);
    if (current) return current;
    const marker = publicName.indexOf("__");
    if (marker < 1) throw new AppError("NOT_FOUND", "Tool not found", 404);
    const projectKey = publicName.slice(0, marker); const originalName = publicName.slice(marker + 2);
    const project = await this.repository.getProjectByKey(projectKey);
    if (!project || project.status === "retired") throw new AppError("NOT_FOUND", "Tool not found", 404);
    if (project.status !== "active" || project.healthStatus !== "healthy") throw new AppError("SERVICE_UNAVAILABLE", "Project is not currently available", 503);
    const runtime = await this.repository.getToolRuntime(project.id, originalName);
    if (runtime?.status === "suspended") throw new AppError("SERVICE_UNAVAILABLE", "Tool is suspended", 503);
    const activeVersion = assertFound(project.activeVersionId ? await this.repository.getVersion(project.activeVersionId) : null, "Active version not found");
    const activeTool = (await this.repository.listTools(activeVersion.id)).find((tool) => tool.originalName === originalName);
    if (!activeTool) {
      const historical = await this.repository.listVersions(project.id);
      for (const version of historical) if ((await this.repository.listTools(version.id)).some((tool) => tool.originalName === originalName)) throw new AppError("TOOL_VERSION_STALE", "Tool version is no longer active", 409);
      throw new AppError("NOT_FOUND", "Tool not found", 404);
    }
    throw new AppError("SERVICE_UNAVAILABLE", "Tool is not currently available", 503);
  }
}
