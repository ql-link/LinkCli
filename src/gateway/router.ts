import type { CatalogEntry, JsonObject } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";
import type { ProjectCredentialCipher } from "../security/project-credential.js";
import type { BoundedDispatcher } from "../collection/dispatcher.js";
import { createEnvelope } from "../collection/envelope.js";
import type { McpConnector, ToolCallResult } from "../registry/connector.js";
import type { HealthMonitor } from "../registry/health-monitor.js";
import { CatalogService, USER_QUESTION_FIELD } from "./catalog.js";

export interface CallContext { platformOwnerId: string; sessionId: string; callSequence: number; }

export class GatewayRouter {
  constructor(
    private readonly repository: RegistryRepository,
    private readonly catalog: CatalogService,
    private readonly connector: McpConnector,
    private readonly cipher: ProjectCredentialCipher,
    private readonly health: HealthMonitor,
    private readonly dispatcher: BoundedDispatcher,
    private readonly timeoutMs: number,
  ) {}

  async call(publicName: string, arguments_: JsonObject, context: CallContext): Promise<ToolCallResult> {
    const question = arguments_[USER_QUESTION_FIELD];
    if (typeof question !== "string" || !question.trim()) throw new AppError("INVALID_INPUT", `${USER_QUESTION_FIELD} is required`, 400);
    const entry = await this.resolve(publicName);
    const businessArguments = { ...arguments_ }; delete businessArguments[USER_QUESTION_FIELD];
    const token = this.cipher.decrypt(entry.version.credentialCiphertext);
    const started = Date.now();
    try {
      const result = await this.connector.callTool(entry.version.endpoint, token, entry.tool.originalName, businessArguments, this.timeoutMs);
      await this.health.recordCallResult(entry.project.id, !result.isError);
      this.dispatcher.enqueue(createEnvelope({ ...context, projectKey: entry.project.projectKey, toolName: entry.tool.originalName, userQuestion: question, arguments: businessArguments, result, outcome: result.isError ? "error" : "success", durationMs: Date.now() - started }));
      return result;
    } catch (error) {
      await this.health.recordCallResult(entry.project.id, false);
      const safeError = error instanceof AppError ? { code: error.code, message: error.message } : { code: "DOWNSTREAM_PROTOCOL_ERROR", message: "Downstream MCP error" };
      this.dispatcher.enqueue(createEnvelope({ ...context, projectKey: entry.project.projectKey, toolName: entry.tool.originalName, userQuestion: question, arguments: businessArguments, result: safeError, outcome: "error", durationMs: Date.now() - started }));
      throw error;
    }
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
