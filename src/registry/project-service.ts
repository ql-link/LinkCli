import { randomUUID } from "node:crypto";
import type { Project, RiskLevel, ServiceVersion, ToolVersion } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";
import type { ProjectCredentialCipher } from "../security/project-credential.js";
import { definitionHash, DiscoveryService } from "./discovery.js";
import type { RegistryEventSink } from "./events.js";
import { classifyRisk } from "./risk-classifier.js";

export interface RegisterProjectInput { projectKey: string; displayName: string; description: string; endpoint: string; projectToken?: string; ownerId: string; }
export interface CreateVersionInput { projectKey: string; endpoint: string; projectToken?: string; submittedBy: string; }

const validateProjectKey = (value: string): void => {
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{1,47}$/.test(value)) throw new AppError("INVALID_INPUT", "projectKey must be 2-48 ASCII letters, numbers, _ or -", 400);
};

export class ProjectService {
  constructor(private readonly repository: RegistryRepository, private readonly discovery: DiscoveryService, private readonly cipher: ProjectCredentialCipher, private readonly events: RegistryEventSink) {}

  async register(input: RegisterProjectInput): Promise<{ project: Project; version: ServiceVersion; tools: ToolVersion[] }> {
    validateProjectKey(input.projectKey);
    if (!input.displayName.trim() || !input.description.trim()) throw new AppError("INVALID_INPUT", "displayName and description are required", 400);
    const discovered = await this.discovery.discover(input.endpoint, input.projectToken ?? null);
    const now = new Date();
    const project: Project = { id: randomUUID(), projectKey: input.projectKey, displayName: input.displayName.trim(), description: input.description.trim(), ownerId: input.ownerId, status: "pending", trustedReviewBypassEnabled: false, activeVersionId: null, healthStatus: "unknown", lastHealthCheckedAt: null, createdAt: now, updatedAt: now };
    const version = this.makeVersion(project.id, 1, input.endpoint, input.projectToken, discovered.protocolVersion, "low", definitionHash(input.endpoint, discovered.protocolVersion, discovered.tools, input.projectToken ?? null), input.ownerId, now);
    const tools = discovered.tools.map((tool) => this.makeTool(version.id, tool, "low"));
    await this.repository.transaction(async (tx) => { await tx.createProject(project); await tx.createVersion(version, tools); });
    return { project, version, tools };
  }

  async createVersion(input: CreateVersionInput): Promise<{ version: ServiceVersion; tools: ToolVersion[]; suspendedTools: string[] }> {
    const projectSnapshot = assertFound(await this.repository.getProjectByKey(input.projectKey), `Project not found: ${input.projectKey}`);
    if (projectSnapshot.status === "retired") throw new AppError("INVALID_STATE", "Retired projects cannot create versions", 409);
    if (projectSnapshot.ownerId !== input.submittedBy) throw new AppError("AUTHORIZATION_FAILED", "Only the project owner can create versions", 403);
    const discovered = await this.discovery.discover(input.endpoint, input.projectToken ?? null);
    const hash = definitionHash(input.endpoint, discovered.protocolVersion, discovered.tools, input.projectToken ?? null);
    let result!: { version: ServiceVersion; tools: ToolVersion[]; suspendedTools: string[] };
    await this.repository.transaction(async (tx) => {
      const project = assertFound(await tx.getProjectByIdForUpdate(projectSnapshot.id), `Project not found: ${input.projectKey}`);
      if (project.status === "retired") throw new AppError("INVALID_STATE", "Retired projects cannot create versions", 409);
      if (project.ownerId !== input.submittedBy) throw new AppError("AUTHORIZATION_FAILED", "Only the project owner can create versions", 403);
      const versions = await tx.listVersions(project.id);
      const existing = versions.find((item) => item.definitionHash.equals(hash));
      if (existing) {
        result = { version: existing, tools: await tx.listTools(existing.id), suspendedTools: [] };
        return;
      }
      const activeTools = project.activeVersionId ? await tx.listTools(project.activeVersionId) : [];
      const risk = classifyRisk(activeTools, discovered.tools);
      const version = this.makeVersion(project.id, Math.max(0, ...versions.map((item) => item.versionNo)) + 1, input.endpoint, input.projectToken, discovered.protocolVersion, risk.overall, hash, input.submittedBy, new Date());
      const tools = discovered.tools.map((tool) => this.makeTool(version.id, tool, risk.toolRisks.get(tool.name) ?? "low"));
      await tx.createVersion(version, tools);
      for (const name of risk.suspendedTools) await tx.upsertToolRuntime({ projectId: project.id, originalName: name, status: "suspended", suspendedReason: `Pending ${risk.overall} definition change`, updatedAt: new Date() });
      result = { version, tools, suspendedTools: risk.suspendedTools };
    });
    for (const name of result.suspendedTools) await this.events.publish({ type: "tool.suspended", projectKey: projectSnapshot.projectKey, toolName: name, reason: `Pending ${result.version.riskLevel} definition change` }).catch(() => undefined);
    return result;
  }

  async setTrustedBypass(projectKey: string, enabled: boolean): Promise<Project> {
    const project = assertFound(await this.repository.getProjectByKey(projectKey), `Project not found: ${projectKey}`);
    project.trustedReviewBypassEnabled = enabled; project.updatedAt = new Date(); await this.repository.updateProject(project); return project;
  }

  private makeVersion(projectId: string, versionNo: number, endpoint: string, token: string | undefined, protocolVersion: string, riskLevel: RiskLevel, hash: Buffer, submittedBy: string, createdAt: Date): ServiceVersion {
    const encrypted = this.cipher.encrypt(token);
    return { id: randomUUID(), projectId, versionNo, endpoint, protocolVersion, credentialCiphertext: encrypted, credentialKeyId: encrypted ? this.cipher.keyId : null, reviewStatus: "draft", riskLevel, definitionHash: hash, submittedBy, submittedAt: null, createdAt };
  }
  private makeTool(versionId: string, tool: { name: string; description: string; inputSchema: Record<string, unknown>; outputSchema: Record<string, unknown> | null }, riskLevel: RiskLevel): ToolVersion {
    return { id: randomUUID(), serviceVersionId: versionId, originalName: tool.name, description: tool.description, inputSchema: tool.inputSchema, outputSchema: tool.outputSchema, riskLevel };
  }
}
