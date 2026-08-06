import type { Project, ServiceVersion } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";
import type { ProjectCredentialCipher } from "../security/project-credential.js";
import type { McpConnector } from "./connector.js";
import type { RegistryEventSink } from "./events.js";

interface Counters { failures: number; successes: number; }

export class HealthMonitor {
  private readonly counters = new Map<string, Counters>();
  constructor(
    private readonly repository: RegistryRepository,
    private readonly connector: McpConnector,
    private readonly cipher: ProjectCredentialCipher,
    private readonly failureThreshold: number,
    private readonly recoveryThreshold: number,
    private readonly timeoutMs: number,
    private readonly events: RegistryEventSink,
  ) {}

  async probeVersion(version: ServiceVersion): Promise<boolean> {
    const project = assertFound(await this.repository.getProjectById(version.projectId), "Project not found");
    const updatesPublishedHealth = !project.activeVersionId || project.activeVersionId === version.id;
    try {
      await this.connector.probe(version.endpoint, this.cipher.decrypt(version.credentialCiphertext), this.timeoutMs);
      if (updatesPublishedHealth) await this.record(version.projectId, true);
      return true;
    } catch {
      if (updatesPublishedHealth) await this.record(version.projectId, false);
      await this.events.publish({ type: "health.alert", projectKey: project.projectKey, versionId: version.id, reason: "MCP health probe failed" }).catch(() => undefined);
      return false;
    }
  }

  async emitStaleAlerts(now = new Date(), staleMs = 7 * 24 * 60 * 60 * 1000): Promise<void> {
    for (const project of await this.repository.listProjects()) {
      for (const version of await this.repository.listVersions(project.id)) {
        if (version.reviewStatus === "pending_review" && version.submittedAt && now.getTime() - version.submittedAt.getTime() >= staleMs) {
          await this.events.publish({ type: "review.stale", projectKey: project.projectKey, versionId: version.id, reason: "Version has remained pending review for more than seven days" }).catch(() => undefined);
        }
      }
      for (const runtime of await this.repository.listToolRuntime(project.id)) {
        if (runtime.status === "suspended" && now.getTime() - runtime.updatedAt.getTime() >= staleMs) {
          await this.events.publish({ type: "tool.suspension.stale", projectKey: project.projectKey, toolName: runtime.originalName, reason: "Tool has remained suspended for more than seven days" }).catch(() => undefined);
        }
      }
    }
  }

  async probeActiveProjects(): Promise<void> {
    for (const project of await this.repository.listProjects()) {
      if (project.status !== "active" || !project.activeVersionId) continue;
      const version = await this.repository.getVersion(project.activeVersionId);
      if (version) await this.probeVersion(version);
    }
  }

  async recordCallResult(projectId: string, succeeded: boolean): Promise<void> {
    await this.record(projectId, succeeded);
  }

  private async record(projectId: string, succeeded: boolean): Promise<void> {
    const project = assertFound(await this.repository.getProjectById(projectId), "Project not found");
    const current = this.counters.get(project.id) ?? { failures: 0, successes: 0 };
    if (succeeded) { current.successes += 1; current.failures = 0; }
    else { current.failures += 1; current.successes = 0; }
    this.counters.set(project.id, current);
    const checkedAt = new Date();
    if (succeeded && (project.healthStatus === "unknown" || current.successes >= this.recoveryThreshold)) project.healthStatus = "healthy";
    if (!succeeded && current.failures >= this.failureThreshold) project.healthStatus = "unhealthy";
    await this.repository.updateProjectHealth(project.id, project.healthStatus, checkedAt);
  }

  async changeProjectStatus(projectKey: string, action: "disable" | "enable" | "retire", actorId: string, isOperator: boolean): Promise<Project> {
    const project = assertFound(await this.repository.getProjectByKey(projectKey), `Project not found: ${projectKey}`);
    if (!isOperator && project.ownerId !== actorId) throw new AppError("AUTHORIZATION_FAILED", "Project status requires owner or operator", 403);
    if (action === "disable") {
      if (project.status === "retired") throw new AppError("INVALID_STATE", "Retired projects cannot be disabled", 409);
      project.status = "disabled";
    } else if (action === "enable") {
      if (project.status !== "disabled") throw new AppError("INVALID_STATE", "Only disabled projects can be enabled", 409);
      if (!project.activeVersionId) throw new AppError("INVALID_STATE", "Project has no approved active version", 409);
      const version = assertFound(await this.repository.getVersion(project.activeVersionId), "Active version not found");
      if (!await this.probeVersion(version)) throw new AppError("SERVICE_UNAVAILABLE", "Project health check failed", 503);
      project.status = "active";
      project.healthStatus = "healthy";
    } else {
      if (!isOperator) throw new AppError("AUTHORIZATION_FAILED", "Only operators can retire projects", 403);
      if (project.status !== "disabled") throw new AppError("INVALID_STATE", "Project must be disabled before retirement", 409);
      project.status = "retired";
    }
    project.updatedAt = new Date();
    await this.repository.updateProject(project);
    return project;
  }
}
