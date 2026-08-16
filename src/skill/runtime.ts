import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "../domain.js";
import type { CollectionRepository } from "../collection/repository.js";
import { createEventId, summarize } from "../collection/envelope.js";
import { resolveAttribution } from "../collection/context.js";
import { AppError, assertFound } from "../errors.js";
import type { McpConnector, ToolCallResult } from "../registry/connector.js";
import type { HealthMonitor } from "../registry/health-monitor.js";
import type { ProjectCredentialCipher } from "../security/project-credential.js";
import { USER_QUESTION_FIELD, type PublicTool, type SkillCatalogProvider } from "../gateway/catalog.js";
import type { CallContext } from "../gateway/router.js";
import type { RegistryRepository } from "../db/repository.js";
import type { SkillService } from "./service.js";
import type { SkillStep, SkillVersion } from "./types.js";

function pathValue(root: JsonObject, path: string): unknown {
  if (!path.startsWith("$")) return path;
  const parts = path.replace(/^\$\.?/, "").split(".").filter(Boolean);
  let current: unknown = root;
  for (const part of parts) { if (!current || typeof current !== "object") return undefined; current = (current as Record<string, unknown>)[part]; }
  return current;
}
function mapArguments(mapping: JsonObject, input: JsonObject, steps: JsonObject): JsonObject {
  const root: JsonObject = { ...input, input, steps };
  return Object.fromEntries(Object.entries(mapping).map(([key, value]) => [key, typeof value === "string" ? pathValue(root, value) : value]));
}
function canaryAllowed(credentialId: string, skillId: string, percent: number): boolean {
  const hash = createHash("sha256").update(`${credentialId}\0${skillId}`).digest().readUInt32BE(0) % 100;
  return hash < percent;
}

export class SkillRuntime implements SkillCatalogProvider {
  constructor(private readonly skills: SkillService, private readonly repository: RegistryRepository, private readonly connector: McpConnector, private readonly cipher: ProjectCredentialCipher, private readonly health: HealthMonitor, private readonly collection: CollectionRepository, private readonly fingerprintKey: Buffer, private readonly timeoutMs: number) {}

  async listTools(): Promise<PublicTool[]> {
    const definitions = await this.skills.runtimeDefinitions();
    return definitions.map(({ publicName, version }) => ({ name: publicName, description: version.definition.description, inputSchema: version.definition.inputSchema, ...(version.definition.outputSchema ? { outputSchema: version.definition.outputSchema } : {}) }));
  }
  async has(publicName: string): Promise<boolean> { return (await this.skills.runtimeDefinitions()).some((item) => item.publicName === publicName); }

  async call(publicName: string, arguments_: JsonObject, context: CallContext): Promise<ToolCallResult> {
    const runtime = (await this.skills.runtimeDefinitions()).find((item) => item.publicName === publicName);
    if (!runtime) throw new AppError("NOT_FOUND", "Skill not found", 404);
    if (!canaryAllowed(context.credentialId, runtime.skill.id, runtime.skill.exposurePercent)) throw new AppError("SERVICE_UNAVAILABLE", "Skill is outside the current gray-release cohort", 503);
    const attribution = resolveAttribution({ credentialId: context.credentialId, transportSessionId: context.transportSessionId, transportSessionSource: context.transportSessionSource, arguments: arguments_, meta: context.meta, fingerprintKey: this.fingerprintKey });
    const businessArguments = { ...arguments_ }; delete businessArguments[USER_QUESTION_FIELD];
    const runId = randomUUID(); const outputs: JsonObject = {}; const stepResults: JsonObject[] = [];
    for (const step of runtime.version.definition.steps) {
      const result = await this.callStep(step, runtime.version, businessArguments, outputs, attribution, context, runId);
      outputs[step.outputKey ?? step.id] = result.structuredContent ?? { content: result.content };
      stepResults.push({ stepId: step.id, outputKey: step.outputKey ?? step.id, result: summarize(result) });
    }
    return { content: [{ type: "text", text: JSON.stringify({ skill: runtime.skill.skillKey, runId, steps: stepResults }) }], structuredContent: { skillId: runtime.skill.id, skillVersionId: runtime.version.id, runId, steps: outputs } };
  }

  private async callStep(step: SkillStep, version: SkillVersion, input: JsonObject, outputs: JsonObject, attribution: ReturnType<typeof resolveAttribution>, context: CallContext, runId: string): Promise<ToolCallResult> {
    if (!step.tool.serviceVersionId || !step.tool.toolVersionId) throw new AppError("INVALID_STATE", `Skill step ${step.id} has no immutable Tool dependency`, 409);
    const serviceVersion = assertFound(await this.repository.getVersion(step.tool.serviceVersionId), "Skill dependency version not found");
    const project = assertFound(await this.repository.getProjectById(step.tool.projectId), "Skill dependency project not found");
    if (project.status !== "active" || project.healthStatus !== "healthy") throw new AppError("SERVICE_UNAVAILABLE", "Skill dependency project is unavailable", 503);
    if (serviceVersion.projectId !== project.id || project.activeVersionId !== serviceVersion.id || serviceVersion.reviewStatus !== "approved") {
      throw new AppError("TOOL_VERSION_STALE", `Skill dependency ${step.tool.originalName} is no longer the active approved version`, 409);
    }
    const runtime = await this.repository.getToolRuntime(project.id, step.tool.originalName);
    if (runtime?.status === "suspended") throw new AppError("SERVICE_UNAVAILABLE", `Skill dependency ${step.tool.originalName} is suspended`, 503);
    const tool = (await this.repository.listTools(serviceVersion.id)).find((item) => item.id === step.tool.toolVersionId && item.originalName === step.tool.originalName);
    if (!tool) throw new AppError("TOOL_VERSION_STALE", `Skill dependency ${step.tool.originalName} is stale`, 409);
    const args = mapArguments(step.inputMapping, input, outputs);
    const eventId = createEventId(); const startedAt = new Date(); const token = this.cipher.decrypt(serviceVersion.credentialCiphertext);
    await this.collection.beginCall({ id: eventId, platformOwnerId: context.platformOwnerId, credentialId: context.credentialId, projectId: project.id, serviceVersionId: serviceVersion.id, toolVersionId: tool.id, projectKey: project.projectKey, toolName: tool.originalName, argumentsSummary: summarize(args), attribution, startedAt, skillId: version.skillId, skillVersionId: version.id, skillRunId: runId, skillStepId: step.id });
    try {
      const result = await this.connector.callTool(serviceVersion.endpoint, token, tool.originalName, args, this.timeoutMs);
      const completedAt = new Date(); await this.collection.completeCall(eventId, { resultSummary: summarize(result), outcome: result.isError ? "error" : "success", errorCode: result.isError ? "DOWNSTREAM_TOOL_ERROR" : null, completedAt, durationMs: completedAt.getTime() - startedAt.getTime() });
      await this.health.recordCallResult(project.id, !result.isError).catch(() => undefined);
      if (result.isError) throw new AppError("DOWNSTREAM_PROTOCOL_ERROR", `Skill step ${step.id} returned an error`, 502);
      return result;
    } catch (error) {
      const completedAt = new Date(); await this.collection.completeCall(eventId, { resultSummary: summarize(error instanceof AppError ? { code: error.code } : { code: "DOWNSTREAM_PROTOCOL_ERROR" }), outcome: "error", errorCode: error instanceof AppError ? error.code : "DOWNSTREAM_PROTOCOL_ERROR", completedAt, durationMs: completedAt.getTime() - startedAt.getTime() }).catch(() => this.collection.markCallPartial(eventId, "COLLECTION_COMPLETION_WRITE_FAILED", completedAt));
      await this.health.recordCallResult(project.id, false).catch(() => undefined);
      throw error;
    }
  }
}
