import { randomUUID } from "node:crypto";
import { AppError, assertFound } from "../errors.js";
import type { SkillCandidate, SkillDefinition, SkillRepository, SkillReview, SkillStatus, SkillValidationJob, SkillValidationRun, SkillVersion, ValidationTrigger } from "./types.js";
import { DeterministicSkillGenerator, type SkillGenerator } from "./generator.js";
import { NoopAuthorityChecker, NoopSkillCaseExecutor, SkillValidationRunner } from "./validation.js";

const allowedRoles = new Set(["owner", "operator"]);
const now = (): Date => new Date();

export class SkillService {
  private readonly generator: SkillGenerator;
  private readonly runner: SkillValidationRunner;

  constructor(private readonly repository: SkillRepository, generator: SkillGenerator = new DeterministicSkillGenerator(), runner = new SkillValidationRunner(new NoopSkillCaseExecutor(), new NoopAuthorityChecker())) {
    this.generator = generator;
    this.runner = runner;
  }

  async list(): Promise<Awaited<ReturnType<SkillRepository["listSkills"]>>> { return this.repository.listSkills(); }
  async get(id: string) { return assertFound(await this.repository.getSkill(id), "Skill not found"); }
  async detail(id: string) {
    const skill = await this.get(id);
    const [version, review, validationRuns, validationJobs] = await Promise.all([
      skill.currentVersionId ? this.repository.getVersion(skill.currentVersionId) : null,
      skill.currentVersionId ? this.repository.getReview(skill.currentVersionId) : null,
      this.repository.listValidationRuns(skill.id),
      this.repository.listValidationJobs(skill.id),
    ]);
    return { skill, version, review, validationRuns, validationJobs };
  }

  async receiveCandidate(candidate: SkillCandidate) {
    const existing = await this.repository.findBySource(candidate.clusterId, candidate.clusterVersion, candidate.candidateType);
    if (existing) return existing;
    const generated = await this.generator.generate(candidate);
    if (!generated.definition.name || !generated.definition.validationCases.length) throw new AppError("INVALID_INPUT", "Generated Skill must contain a name and fixed validation samples", 400);
    const createdAt = candidate.receivedAt ? new Date(candidate.receivedAt) : now();
    const skill = { id: randomUUID(), skillKey: `l4-${candidate.clusterId}-${candidate.candidateType}`, sourceClusterId: candidate.clusterId, sourceClusterVersion: candidate.clusterVersion, candidateType: candidate.candidateType, status: "draft" as const, currentVersionId: null as string | null, exposurePercent: 0, revision: 0, statusReason: null, createdAt, updatedAt: createdAt };
    const version: SkillVersion = { id: randomUUID(), skillId: skill.id, versionNo: 1, definition: generated.definition, dependencySnapshot: generated.definition.steps.map((step) => step.tool), generatorModel: generated.model, sourceEventId: candidate.eventId, createdAt };
    skill.currentVersionId = version.id;
    if (await this.repository.createDraft(skill, version)) return skill;
    return assertFound(await this.repository.findBySource(candidate.clusterId, candidate.clusterVersion, candidate.candidateType), "Skill candidate was concurrently created");
  }

  async revise(skillId: string, definition: SkillDefinition, actorId: string, model = "manual-l4-v1", at = now()) {
    const skill = await this.get(skillId);
    if (["canary", "active", "paused", "retired"].includes(skill.status)) throw new AppError("INVALID_STATE", "Active or retired Skill must be copied before revision", 409);
    const current = assertFound(skill.currentVersionId ? await this.repository.getVersion(skill.currentVersionId) : null, "Skill version not found");
    if (!definition.validationCases.length) throw new AppError("INVALID_INPUT", "Skill revision must contain fixed validation samples", 400);
    const version: SkillVersion = { id: randomUUID(), skillId, versionNo: current.versionNo + 1, definition, dependencySnapshot: definition.steps.map((step) => step.tool), generatorModel: model, sourceEventId: `manual:${actorId}:${randomUUID()}`, createdAt: at };
    if (!(await this.repository.createVersion(version))) throw new AppError("CONFLICT", "Skill version already exists", 409);
    const updated = { ...skill, currentVersionId: version.id, status: "draft" as const, statusReason: `Revised by ${actorId}`, revision: skill.revision + 1, updatedAt: at };
    await this.repository.updateSkill(updated);
    return { skill: updated, version };
  }

  async validate(skillId: string, trigger: ValidationTrigger, at = now()): Promise<SkillValidationRun> {
    let skill = await this.get(skillId);
    const version = assertFound(skill.currentVersionId ? await this.repository.getVersion(skill.currentVersionId) : null, "Skill version not found");
    if (["retired", "canary"].includes(skill.status)) throw new AppError("INVALID_STATE", `Skill cannot be validated from ${skill.status}`, 409);
    if (skill.status === "active") skill = await this.updateStatus(skill, "paused", "Validation required before active Skill can continue");
    if (!["draft", "paused", "degraded", "validating"].includes(skill.status)) throw new AppError("INVALID_STATE", `Skill cannot be validated from ${skill.status}`, 409);
    skill = await this.updateStatus(skill, "validating", `Validation triggered by ${trigger}`);
    const result = await this.runner.run(version, skill.id, trigger);
    const existing = await this.repository.findValidationRun(version.id, trigger, result.sampleSetHash);
    if (existing) {
      const nextStatus: SkillStatus = existing.verdict === "passed" ? "pending_review" : existing.verdict === "insufficient" ? "validating" : "degraded";
      if ((await this.get(skill.id)).status === "validating") await this.updateStatus(await this.get(skill.id), nextStatus, `Validation verdict: ${existing.verdict}`);
      return existing;
    }
    const run: SkillValidationRun = { id: randomUUID(), createdAt: at, ...result.run };
    await this.repository.createValidationRun(run);
    const nextStatus: SkillStatus = run.verdict === "passed" ? "pending_review" : run.verdict === "insufficient" ? "validating" : "degraded";
    await this.updateStatus(await this.get(skill.id), nextStatus, `Validation verdict: ${run.verdict}`);
    return run;
  }

  async enqueueValidation(skillId: string, trigger: ValidationTrigger, at = now()): Promise<SkillValidationJob> {
    const skill = await this.get(skillId);
    const version = assertFound(skill.currentVersionId ? await this.repository.getVersion(skill.currentVersionId) : null, "Skill version not found");
    const job: SkillValidationJob = { id: randomUUID(), skillId, skillVersionId: version.id, trigger, status: "pending", attempts: 0, nextAttemptAt: at, leaseOwner: null, leaseUntil: null, lastError: null, createdAt: at, updatedAt: at };
    if (await this.repository.enqueueValidation(job)) return job;
    const active = await this.repository.findActiveValidationJob(version.id, trigger);
    if (active) return active;
    if (await this.repository.enqueueValidation(job)) return job;
    return assertFound(await this.repository.findActiveValidationJob(version.id, trigger), "Active validation job not found after a concurrent enqueue");
  }

  async submitReview(skillId: string, actorId: string) {
    const skill = await this.get(skillId);
    if (skill.status !== "pending_review") throw new AppError("INVALID_STATE", "Only a validated Skill can enter review", 409);
    return { skill, actorId };
  }

  async decideReview(skillId: string, decision: SkillReview["decision"], reviewerId: string, comment: string | null = null) {
    const skill = await this.get(skillId);
    if (skill.status !== "pending_review" || !skill.currentVersionId) throw new AppError("INVALID_STATE", "Skill is not waiting for review", 409);
    const review: SkillReview = { id: randomUUID(), skillId, skillVersionId: skill.currentVersionId, decision, comment, reviewerId, decidedAt: now() };
    if (!(await this.repository.createReview(review))) return { skill, review: await this.repository.getReview(skill.currentVersionId) };
    const updated = await this.updateStatus(skill, decision === "approved" ? "canary" : "degraded", decision === "approved" ? "Review approved; waiting for canary" : "Review rejected", decision === "approved" ? 10 : 0);
    return { skill: updated, review };
  }

  async lifecycle(skillId: string, action: "canary" | "activate" | "pause" | "resume" | "degrade" | "retire", reason: string | null = null) {
    const skill = await this.get(skillId);
    const transitions: Record<string, SkillStatus[]> = { canary: ["pending_review"], activate: ["canary"], pause: ["canary", "active"], resume: ["paused"], degrade: ["canary", "active", "paused"], retire: ["draft", "validating", "pending_review", "canary", "active", "paused", "degraded"] };
    if (!transitions[action]!.includes(skill.status)) throw new AppError("INVALID_STATE", `Cannot ${action} Skill from ${skill.status}`, 409);
    if (action === "activate" && (await this.repository.getReview(skill.currentVersionId ?? ""))?.decision !== "approved") throw new AppError("INVALID_STATE", "Skill must have an approved review before activation", 409);
    if (action === "activate") {
      const version = assertFound(skill.currentVersionId ? await this.repository.getVersion(skill.currentVersionId) : null, "Skill version not found");
      if (!version.definition.steps.length || version.dependencySnapshot.some((dependency) => !dependency.serviceVersionId || !dependency.toolVersionId)) throw new AppError("INVALID_STATE", "Skill dependencies are not bound to immutable Tool versions", 409);
    }
    const next: Record<string, SkillStatus> = { canary: "canary", activate: "active", pause: "paused", resume: "validating", degrade: "degraded", retire: "retired" };
    const exposurePercent = action === "canary" ? 10 : action === "activate" ? 100 : action === "retire" || action === "degrade" || action === "pause" ? 0 : skill.exposurePercent;
    return this.updateStatus(skill, next[action]!, reason ?? `Lifecycle action: ${action}`, exposurePercent);
  }

  async runtimeDefinitions() {
    const rows = await this.repository.listSkills();
    const result = [];
    for (const skill of rows) {
      if (!["canary", "active"].includes(skill.status) || skill.exposurePercent <= 0 || !skill.currentVersionId) continue;
      const version = await this.repository.getVersion(skill.currentVersionId);
      if (version) result.push({ publicName: `skill__${skill.skillKey}`, skill, version });
    }
    return result;
  }

  async handleDependencyChange(toolVersionId: string, reason = "Skill dependency changed") {
    const affected: string[] = [];
    for (const skill of await this.repository.listSkills()) {
      if (!["canary", "active"].includes(skill.status) || !skill.currentVersionId) continue;
      const version = await this.repository.getVersion(skill.currentVersionId);
      if (!version?.dependencySnapshot.some((dependency) => dependency.toolVersionId === toolVersionId)) continue;
      await this.updateStatus(skill, "paused", reason, 0);
      await this.enqueueValidation(skill.id, "dependency_change");
      affected.push(skill.id);
    }
    return affected;
  }

  private async updateStatus(skill: Awaited<ReturnType<SkillService["get"]>>, status: SkillStatus, reason: string, exposurePercent = skill.exposurePercent) {
    const updated = { ...skill, status, exposurePercent, statusReason: reason, revision: skill.revision + 1, updatedAt: now() };
    await this.repository.updateSkill(updated);
    return updated;
  }
}

export const isSkillOperatorRole = (role: string): boolean => allowedRoles.has(role);
