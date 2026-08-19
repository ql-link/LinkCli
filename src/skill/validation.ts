import type { JsonObject } from "../domain.js";
import { sampleSetHash } from "./generator.js";
import type { AuthorityChecker, SkillCaseExecutor, SkillValidationObservation, SkillValidationRun, SkillVersion, SkillValidationCase, ValidationTrigger } from "./types.js";
import type { RegistryRepository } from "../db/repository.js";
import type { McpConnector } from "../registry/connector.js";
import type { ProjectCredentialCipher } from "../security/project-credential.js";
import { assertFound } from "../errors.js";

export class NoopSkillCaseExecutor implements SkillCaseExecutor {
  async execute(): Promise<SkillValidationObservation> { return { verdict: "insufficient", replay: { status: "not_configured" }, databaseCheck: { status: "not_configured" } }; }
}

export class NoopAuthorityChecker implements AuthorityChecker {
  async check(): Promise<{ verdict: "insufficient"; summary: JsonObject }> { return { verdict: "insufficient", summary: { status: "not_configured" } }; }
}

function resolvePath(root: JsonObject, expression: string): unknown {
  if (!expression.startsWith("$")) return expression;
  let current: unknown = root;
  for (const part of expression.replace(/^\$\.?/, "").split(".").filter(Boolean)) { if (!current || typeof current !== "object") return undefined; current = (current as Record<string, unknown>)[part]; }
  return current;
}

/** 在验证 Worker 中执行固定样本的真实 Tool 步骤；不重试，也不进入用户请求链路。 */
export class ToolValidationExecutor implements SkillCaseExecutor {
  constructor(private readonly repository: RegistryRepository, private readonly connector: McpConnector, private readonly cipher: ProjectCredentialCipher, private readonly timeoutMs: number) {}
  async execute(sample: SkillValidationCase, version: SkillVersion): Promise<SkillValidationObservation> {
    const outputs: JsonObject = {}; const observations: JsonObject[] = [];
    for (const step of version.definition.steps) {
      if (!step.tool.serviceVersionId || !step.tool.toolVersionId) return { verdict: "insufficient", replay: { status: "dependency_unbound", stepId: step.id }, databaseCheck: { status: "not_applicable" } };
      const service = assertFound(await this.repository.getVersion(step.tool.serviceVersionId), "Validation dependency version not found");
      const project = assertFound(await this.repository.getProjectById(step.tool.projectId), "Validation dependency project not found");
      if (project.status !== "active" || project.healthStatus !== "healthy") return { verdict: "insufficient", replay: { status: "project_unavailable", stepId: step.id }, databaseCheck: { status: "not_applicable" } };
      if (service.projectId !== project.id || project.activeVersionId !== service.id || service.reviewStatus !== "approved") return { verdict: "failed", replay: { status: "stale_dependency", stepId: step.id }, databaseCheck: { status: "not_applicable" } };
      const runtime = await this.repository.getToolRuntime(project.id, step.tool.originalName);
      if (runtime?.status === "suspended") return { verdict: "insufficient", replay: { status: "tool_suspended", stepId: step.id }, databaseCheck: { status: "not_applicable" } };
      const tool = (await this.repository.listTools(service.id)).find((item) => item.id === step.tool.toolVersionId && item.originalName === step.tool.originalName);
      if (!tool) return { verdict: "failed", replay: { status: "stale_dependency", stepId: step.id }, databaseCheck: { status: "not_applicable" } };
      const root: JsonObject = { ...sample.input, input: sample.input, steps: outputs };
      const args = Object.fromEntries(Object.entries(step.inputMapping).map(([key, value]) => [key, typeof value === "string" ? resolvePath(root, value) : value]));
      const result = await this.connector.callTool(service.endpoint, this.cipher.decrypt(service.credentialCiphertext), tool.originalName, args, this.timeoutMs);
      observations.push({ stepId: step.id, isError: Boolean(result.isError), structuredContent: result.structuredContent ?? null });
      if (result.isError) return { verdict: "failed", replay: { observations }, databaseCheck: { status: "not_applicable" } };
      outputs[step.outputKey ?? step.id] = result.structuredContent ?? { content: result.content };
    }
    return { verdict: version.definition.steps.length ? "passed" : "insufficient", replay: { observations, outputs }, databaseCheck: { status: "pending_authority_check" } };
  }
}

export interface ValidationResult { run: Omit<SkillValidationRun, "id" | "createdAt">; sampleSetHash: string; }

export class SkillValidationRunner {
  constructor(private readonly executor: SkillCaseExecutor = new NoopSkillCaseExecutor(), private readonly authority: AuthorityChecker = new NoopAuthorityChecker()) {}

  async run(version: SkillVersion, skillId: string, trigger: ValidationTrigger): Promise<ValidationResult> {
    const hash = sampleSetHash(version.definition);
    const observations: JsonObject[] = [];
    let verdict: SkillValidationRun["verdict"] = version.definition.validationCases.length ? "passed" : "insufficient";
    for (const sample of version.definition.validationCases) {
      const replay = await this.executor.execute(sample, version);
      const check = replay.verdict === "passed" ? await this.authority.check(sample, version, replay.replay) : { verdict: replay.verdict, summary: replay.databaseCheck };
      observations.push({ sampleId: sample.id, replay: replay.replay, databaseCheck: check.summary, verdict: check.verdict });
      if (check.verdict === "failed" || check.verdict === "cluster_error") { verdict = check.verdict; break; }
      if (check.verdict === "insufficient") verdict = "insufficient";
    }
    return { sampleSetHash: hash, run: { skillId, skillVersionId: version.id, trigger, sampleSetHash: hash, verdict, replaySummary: { sampleCount: version.definition.validationCases.length, observations }, databaseCheckSummary: { status: verdict === "passed" ? "passed" : verdict } } };
  }
}
