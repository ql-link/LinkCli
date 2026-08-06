import type { Project, Review, ReviewDecision, ServiceVersion } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";
import type { RegistryEventSink } from "./events.js";
import type { HealthMonitor } from "./health-monitor.js";
import { classifyRisk } from "./risk-classifier.js";

export class ReviewService {
  constructor(private readonly repository: RegistryRepository, private readonly health: HealthMonitor, private readonly events: RegistryEventSink) {}

  async submit(versionId: string, actorId: string): Promise<ServiceVersion> {
    const version = assertFound(await this.repository.getVersion(versionId), "Version not found");
    const project = assertFound(await this.repository.getProjectById(version.projectId), "Project not found");
    if (project.ownerId !== actorId) throw new AppError("AUTHORIZATION_FAILED", "Only the project owner can submit a version", 403);
    if (version.reviewStatus !== "draft") {
      if (version.reviewStatus === "pending_review") return version;
      throw new AppError("INVALID_STATE", `Version is already ${version.reviewStatus}`, 409);
    }
    if (!project.trustedReviewBypassEnabled) {
      version.reviewStatus = "pending_review";
      version.submittedAt = new Date();
      await this.repository.updateVersion(version);
      return version;
    }
    await this.repository.transaction(async (tx) => {
      const current = assertFound(await tx.getVersionForUpdate(versionId), "Version not found");
      if (current.reviewStatus !== "draft") return;
      const review: Review = { serviceVersionId: versionId, decision: "bypassed", comment: "Trusted project review bypass", reviewerId: "system", decidedAt: new Date() };
      if (!await tx.createReview(review)) throw new AppError("CONFLICT", "Review already decided", 409);
      current.reviewStatus = "approved";
      current.submittedAt = new Date();
      await tx.updateVersion(current);
      version.reviewStatus = "approved";
      version.submittedAt = current.submittedAt;
    });
    if (await this.health.probeVersion(version)) await this.publish(version, project);
    return version;
  }

  async decide(versionId: string, decision: Exclude<ReviewDecision, "bypassed">, reviewerId: string, comment?: string): Promise<{ version: ServiceVersion; project: Project; published: boolean }> {
    if (decision === "rejected" && !comment?.trim()) throw new AppError("INVALID_INPUT", "Rejection comment is required", 400);
    let version!: ServiceVersion;
    let project!: Project;
    const restoredAfterRejection: string[] = [];
    await this.repository.transaction(async (tx) => {
      version = assertFound(await tx.getVersionForUpdate(versionId), "Version not found");
      project = assertFound(await tx.getProjectByIdForUpdate(version.projectId), "Project not found");
      if (version.submittedBy === reviewerId) throw new AppError("AUTHORIZATION_FAILED", "Submitter cannot review their own version", 403);
      if (version.reviewStatus !== "pending_review") {
        const existing = await tx.getReview(versionId);
        throw new AppError("CONFLICT", `Version review already decided as ${existing?.decision ?? version.reviewStatus}`, 409, { currentStatus: version.reviewStatus });
      }
      const review: Review = { serviceVersionId: versionId, decision, comment: comment?.trim() || null, reviewerId, decidedAt: new Date() };
      if (!await tx.createReview(review)) throw new AppError("CONFLICT", "Review already decided", 409);
      version.reviewStatus = decision === "approved" ? "approved" : "rejected";
      await tx.updateVersion(version);
      if (decision === "rejected" && project.activeVersionId) {
        const activeTools = await tx.listTools(project.activeVersionId);
        const rejectedTools = (await tx.listTools(version.id)).map((tool) => ({ name: tool.originalName, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }));
        const rejectedSuspensions = classifyRisk(activeTools, rejectedTools).suspendedTools;
        const stillRequired = new Set<string>();
        for (const candidate of await tx.listVersions(project.id)) {
          if (candidate.id === version.id || candidate.id === project.activeVersionId || !["draft", "pending_review", "approved"].includes(candidate.reviewStatus)) continue;
          const candidateTools = (await tx.listTools(candidate.id)).map((tool) => ({ name: tool.originalName, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema }));
          for (const name of classifyRisk(activeTools, candidateTools).suspendedTools) stillRequired.add(name);
        }
        for (const name of rejectedSuspensions) {
          if (stillRequired.has(name)) continue;
          const runtime = await tx.getToolRuntime(project.id, name);
          if (runtime?.status !== "suspended") continue;
          await tx.upsertToolRuntime({ ...runtime, status: "active", suspendedReason: null, updatedAt: new Date() });
          restoredAfterRejection.push(name);
        }
      }
    });
    for (const name of restoredAfterRejection) await this.events.publish({ type: "tool.restored", projectKey: project.projectKey, toolName: name }).catch(() => undefined);
    let published = false;
    if (decision === "approved" && await this.health.probeVersion(version)) {
      published = await this.publish(version, project);
      project = assertFound(await this.repository.getProjectById(project.id), "Project not found");
    }
    return { version, project, published };
  }

  private async publish(version: ServiceVersion, projectSnapshot: Project): Promise<boolean> {
    const restored: string[] = [];
    let switched = false;
    await this.repository.transaction(async (tx) => {
      const currentVersion = assertFound(await tx.getVersionForUpdate(version.id), "Version not found");
      if (currentVersion.reviewStatus !== "approved") throw new AppError("INVALID_STATE", "Only approved versions can be published", 409);
      const project = assertFound(await tx.getProjectByIdForUpdate(projectSnapshot.id), "Project not found");
      if (project.status === "retired") throw new AppError("INVALID_STATE", "Retired projects cannot publish versions", 409);
      if (project.activeVersionId) {
        const activeVersion = assertFound(await tx.getVersion(project.activeVersionId), "Active version not found");
        if (activeVersion.versionNo > currentVersion.versionNo) return;
      }
      project.activeVersionId = currentVersion.id;
      project.healthStatus = "healthy";
      if (project.status === "pending") project.status = "active";
      project.lastHealthCheckedAt = new Date();
      project.updatedAt = project.lastHealthCheckedAt;
      await tx.updateProject(project);
      switched = true;
      for (const tool of await tx.listTools(currentVersion.id)) {
        const runtime = await tx.getToolRuntime(project.id, tool.originalName);
        if (runtime?.status === "suspended") {
          await tx.upsertToolRuntime({ ...runtime, status: "active", suspendedReason: null, updatedAt: new Date() });
          restored.push(tool.originalName);
        }
      }
    });
    if (!switched) return false;
    await this.events.publish({ type: "version.published", projectKey: projectSnapshot.projectKey, versionId: version.id }).catch(() => undefined);
    for (const name of restored) await this.events.publish({ type: "tool.restored", projectKey: projectSnapshot.projectKey, toolName: name }).catch(() => undefined);
    return true;
  }
}
