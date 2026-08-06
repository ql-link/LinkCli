import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import type {
  CallCredential,
  CatalogEntry,
  Project,
  Review,
  ServiceVersion,
  ToolRuntime,
  ToolVersion,
} from "../domain.js";
import { AppError } from "../errors.js";

export interface RegistryRepository {
  transaction<T>(work: (repository: RegistryRepository) => Promise<T>): Promise<T>;
  createProject(project: Project): Promise<void>;
  updateProject(project: Project): Promise<void>;
  updateProjectHealth(projectId: string, healthStatus: Project["healthStatus"], checkedAt: Date): Promise<void>;
  getProjectById(id: string): Promise<Project | null>;
  getProjectByIdForUpdate(id: string): Promise<Project | null>;
  getProjectByKey(projectKey: string): Promise<Project | null>;
  listProjects(): Promise<Project[]>;
  createVersion(version: ServiceVersion, tools: ToolVersion[]): Promise<void>;
  updateVersion(version: ServiceVersion): Promise<void>;
  getVersion(id: string): Promise<ServiceVersion | null>;
  getVersionForUpdate(id: string): Promise<ServiceVersion | null>;
  listVersions(projectId: string): Promise<ServiceVersion[]>;
  listTools(versionId: string): Promise<ToolVersion[]>;
  createReview(review: Review): Promise<boolean>;
  getReview(versionId: string): Promise<Review | null>;
  upsertToolRuntime(runtime: ToolRuntime): Promise<void>;
  getToolRuntime(projectId: string, originalName: string): Promise<ToolRuntime | null>;
  listToolRuntime(projectId: string): Promise<ToolRuntime[]>;
  listCatalog(): Promise<CatalogEntry[]>;
  createCallCredential(credential: CallCredential): Promise<void>;
  updateCallCredential(credential: CallCredential): Promise<void>;
  getCallCredentialByDigest(digest: Buffer): Promise<CallCredential | null>;
  getCallCredential(id: string): Promise<CallCredential | null>;
  listCallCredentials(ownerId: string): Promise<CallCredential[]>;
}

class AsyncMutex {
  private tail = Promise.resolve();
  async run<T>(work: () => Promise<T>): Promise<T> {
    const previous = this.tail;
    let release!: () => void;
    this.tail = new Promise<void>((resolve) => { release = resolve; });
    await previous;
    try { return await work(); } finally { release(); }
  }
}

function clone<T>(value: T): T {
  if (Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)])) as T;
  }
  return value;
}

export class MemoryRegistryRepository implements RegistryRepository {
  private readonly mutex = new AsyncMutex();
  private readonly projects = new Map<string, Project>();
  private readonly versions = new Map<string, ServiceVersion>();
  private readonly tools = new Map<string, ToolVersion[]>();
  private readonly reviews = new Map<string, Review>();
  private readonly runtime = new Map<string, ToolRuntime>();
  private readonly credentials = new Map<string, CallCredential>();
  async transaction<T>(work: (repository: RegistryRepository) => Promise<T>): Promise<T> {
    return this.mutex.run(() => work(this));
  }

  async createProject(project: Project): Promise<void> {
    if ([...this.projects.values()].some((item) => item.projectKey === project.projectKey)) {
      throw new AppError("CONFLICT", `Project key already exists: ${project.projectKey}`, 409);
    }
    this.projects.set(project.id, clone(project));
  }
  async updateProject(project: Project): Promise<void> { this.projects.set(project.id, clone(project)); }
  async updateProjectHealth(projectId: string, healthStatus: Project["healthStatus"], checkedAt: Date): Promise<void> {
    const project = this.projects.get(projectId);
    if (!project) return;
    project.healthStatus = healthStatus; project.lastHealthCheckedAt = checkedAt; project.updatedAt = checkedAt;
  }
  async getProjectById(id: string): Promise<Project | null> { return clone(this.projects.get(id) ?? null); }
  async getProjectByIdForUpdate(id: string): Promise<Project | null> { return this.getProjectById(id); }
  async getProjectByKey(key: string): Promise<Project | null> {
    return clone([...this.projects.values()].find((item) => item.projectKey === key) ?? null);
  }
  async listProjects(): Promise<Project[]> { return clone([...this.projects.values()]); }
  async createVersion(version: ServiceVersion, tools: ToolVersion[]): Promise<void> {
    const duplicate = tools.find((tool, index) => tools.findIndex((candidate) => candidate.originalName === tool.originalName) !== index);
    if (duplicate) throw new AppError("CONFLICT", `Duplicate tool name: ${duplicate.originalName}`, 409);
    this.versions.set(version.id, clone(version));
    this.tools.set(version.id, clone(tools));
  }
  async updateVersion(version: ServiceVersion): Promise<void> { this.versions.set(version.id, clone(version)); }
  async getVersion(id: string): Promise<ServiceVersion | null> { return clone(this.versions.get(id) ?? null); }
  async getVersionForUpdate(id: string): Promise<ServiceVersion | null> { return this.getVersion(id); }
  async listVersions(projectId: string): Promise<ServiceVersion[]> {
    return clone([...this.versions.values()].filter((item) => item.projectId === projectId).sort((a, b) => a.versionNo - b.versionNo));
  }
  async listTools(versionId: string): Promise<ToolVersion[]> { return clone(this.tools.get(versionId) ?? []); }
  async createReview(review: Review): Promise<boolean> {
    if (this.reviews.has(review.serviceVersionId)) return false;
    this.reviews.set(review.serviceVersionId, clone(review));
    return true;
  }
  async getReview(versionId: string): Promise<Review | null> { return clone(this.reviews.get(versionId) ?? null); }
  async upsertToolRuntime(runtime: ToolRuntime): Promise<void> {
    this.runtime.set(`${runtime.projectId}\0${runtime.originalName}`, clone(runtime));
  }
  async getToolRuntime(projectId: string, originalName: string): Promise<ToolRuntime | null> {
    return clone(this.runtime.get(`${projectId}\0${originalName}`) ?? null);
  }
  async listToolRuntime(projectId: string): Promise<ToolRuntime[]> {
    return clone([...this.runtime.values()].filter((item) => item.projectId === projectId));
  }
  async listCatalog(): Promise<CatalogEntry[]> {
    const entries: CatalogEntry[] = [];
    for (const project of this.projects.values()) {
      if (project.status !== "active" || project.healthStatus !== "healthy" || !project.activeVersionId) continue;
      const version = this.versions.get(project.activeVersionId);
      if (!version || version.reviewStatus !== "approved") continue;
      for (const tool of this.tools.get(version.id) ?? []) {
        const state = this.runtime.get(`${project.id}\0${tool.originalName}`);
        if (state?.status === "suspended") continue;
        entries.push({ publicName: `${project.projectKey}__${tool.originalName}`, project: clone(project), version: clone(version), tool: clone(tool) });
      }
    }
    return entries;
  }
  async createCallCredential(credential: CallCredential): Promise<void> {
    if ([...this.credentials.values()].some((item) => item.tokenDigest.equals(credential.tokenDigest))) {
      throw new AppError("CONFLICT", "Credential token already exists", 409);
    }
    this.credentials.set(credential.id, clone(credential));
  }
  async updateCallCredential(credential: CallCredential): Promise<void> { this.credentials.set(credential.id, clone(credential)); }
  async getCallCredentialByDigest(digest: Buffer): Promise<CallCredential | null> {
    return clone([...this.credentials.values()].find((item) => item.tokenDigest.equals(digest)) ?? null);
  }
  async getCallCredential(id: string): Promise<CallCredential | null> { return clone(this.credentials.get(id) ?? null); }
  async listCallCredentials(ownerId: string): Promise<CallCredential[]> {
    return clone([...this.credentials.values()].filter((item) => item.ownerId === ownerId));
  }
}

type Executor = Pool | PoolConnection;
const bool = (value: unknown): boolean => value === 1 || value === true;
const date = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const nullableDate = (value: unknown): Date | null => value === null ? null : date(value);
const isDuplicateEntry = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY");

function projectFrom(row: RowDataPacket): Project {
  return { id: row.id, projectKey: row.project_key, displayName: row.display_name, description: row.description, ownerId: row.owner_id,
    status: row.status, trustedReviewBypassEnabled: bool(row.trusted_review_bypass_enabled), activeVersionId: row.active_version_id,
    healthStatus: row.health_status, lastHealthCheckedAt: nullableDate(row.last_health_checked_at), createdAt: date(row.created_at), updatedAt: date(row.updated_at) };
}
function versionFrom(row: RowDataPacket): ServiceVersion {
  return { id: row.id, projectId: row.project_id, versionNo: Number(row.version_no), endpoint: row.endpoint, protocolVersion: row.protocol_version,
    credentialCiphertext: row.credential_ciphertext, credentialKeyId: row.credential_key_id, reviewStatus: row.review_status, riskLevel: row.risk_level,
    definitionHash: Buffer.from(row.definition_hash), submittedBy: row.submitted_by, submittedAt: nullableDate(row.submitted_at), createdAt: date(row.created_at) };
}
function toolFrom(row: RowDataPacket): ToolVersion {
  return { id: row.id, serviceVersionId: row.service_version_id, originalName: row.original_name, description: row.description,
    inputSchema: typeof row.input_schema === "string" ? JSON.parse(row.input_schema) : row.input_schema,
    outputSchema: row.output_schema === null ? null : typeof row.output_schema === "string" ? JSON.parse(row.output_schema) : row.output_schema,
    riskLevel: row.risk_level };
}
function credentialFrom(row: RowDataPacket): CallCredential {
  return { id: row.id, ownerId: row.owner_id, credentialName: row.credential_name, tokenPrefix: row.token_prefix,
    tokenDigest: Buffer.from(row.token_digest), expiresAt: nullableDate(row.expires_at), createdAt: date(row.created_at), revokedAt: nullableDate(row.revoked_at) };
}

export class MySqlRegistryRepository implements RegistryRepository {
  constructor(private readonly executor: Executor, private readonly pool?: Pool) {}
  async transaction<T>(work: (repository: RegistryRepository) => Promise<T>): Promise<T> {
    if (!this.pool) return work(this);
    const connection = await this.pool.getConnection();
    try {
      await connection.beginTransaction();
      const result = await work(new MySqlRegistryRepository(connection));
      await connection.commit();
      return result;
    } catch (error) {
      await connection.rollback();
      throw error;
    } finally { connection.release(); }
  }
  async createProject(p: Project): Promise<void> {
    try {
      await this.executor.execute("INSERT INTO mcp_projects (id,project_key,display_name,description,owner_id,status,trusted_review_bypass_enabled,active_version_id,health_status,last_health_checked_at,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)",
        [p.id,p.projectKey,p.displayName,p.description,p.ownerId,p.status,p.trustedReviewBypassEnabled,p.activeVersionId,p.healthStatus,p.lastHealthCheckedAt,p.createdAt,p.updatedAt]);
    } catch (error) {
      if (isDuplicateEntry(error)) throw new AppError("CONFLICT", `Project key already exists: ${p.projectKey}`, 409);
      throw error;
    }
  }
  async updateProject(p: Project): Promise<void> {
    await this.executor.execute("UPDATE mcp_projects SET display_name=?,description=?,owner_id=?,status=?,trusted_review_bypass_enabled=?,active_version_id=?,health_status=?,last_health_checked_at=?,updated_at=? WHERE id=?",
      [p.displayName,p.description,p.ownerId,p.status,p.trustedReviewBypassEnabled,p.activeVersionId,p.healthStatus,p.lastHealthCheckedAt,p.updatedAt,p.id]);
  }
  async updateProjectHealth(projectId: string, healthStatus: Project["healthStatus"], checkedAt: Date): Promise<void> {
    await this.executor.execute("UPDATE mcp_projects SET health_status=?,last_health_checked_at=?,updated_at=? WHERE id=?", [healthStatus, checkedAt, checkedAt, projectId]);
  }
  async getProjectById(id: string): Promise<Project | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_projects WHERE id=?",[id]); return rows[0] ? projectFrom(rows[0]) : null; }
  async getProjectByIdForUpdate(id: string): Promise<Project | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_projects WHERE id=? FOR UPDATE",[id]); return rows[0] ? projectFrom(rows[0]) : null; }
  async getProjectByKey(key: string): Promise<Project | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_projects WHERE project_key=?",[key]); return rows[0] ? projectFrom(rows[0]) : null; }
  async listProjects(): Promise<Project[]> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_projects ORDER BY created_at"); return rows.map(projectFrom); }
  async createVersion(v: ServiceVersion, tools: ToolVersion[]): Promise<void> {
    await this.executor.execute("INSERT INTO mcp_service_versions (id,project_id,version_no,endpoint,protocol_version,credential_ciphertext,credential_key_id,review_status,risk_level,definition_hash,submitted_by,submitted_at,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
      [v.id,v.projectId,v.versionNo,v.endpoint,v.protocolVersion,v.credentialCiphertext,v.credentialKeyId,v.reviewStatus,v.riskLevel,v.definitionHash,v.submittedBy,v.submittedAt,v.createdAt]);
    for (const t of tools) await this.executor.execute("INSERT INTO mcp_tool_versions (id,service_version_id,original_name,description,input_schema,output_schema,risk_level) VALUES (?,?,?,?,?,?,?)",
      [t.id,t.serviceVersionId,t.originalName,t.description,JSON.stringify(t.inputSchema),t.outputSchema ? JSON.stringify(t.outputSchema) : null,t.riskLevel]);
  }
  async updateVersion(v: ServiceVersion): Promise<void> { await this.executor.execute("UPDATE mcp_service_versions SET review_status=?,submitted_at=? WHERE id=?",[v.reviewStatus,v.submittedAt,v.id]); }
  async getVersion(id: string): Promise<ServiceVersion | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_service_versions WHERE id=?",[id]); return rows[0] ? versionFrom(rows[0]) : null; }
  async getVersionForUpdate(id: string): Promise<ServiceVersion | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_service_versions WHERE id=? FOR UPDATE",[id]); return rows[0] ? versionFrom(rows[0]) : null; }
  async listVersions(projectId: string): Promise<ServiceVersion[]> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_service_versions WHERE project_id=? ORDER BY version_no",[projectId]); return rows.map(versionFrom); }
  async listTools(versionId: string): Promise<ToolVersion[]> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_tool_versions WHERE service_version_id=? ORDER BY original_name",[versionId]); return rows.map(toolFrom); }
  async createReview(r: Review): Promise<boolean> { const [result] = await this.executor.execute<ResultSetHeader>("INSERT IGNORE INTO mcp_reviews (service_version_id,decision,comment,reviewer_id,decided_at) VALUES (?,?,?,?,?)",[r.serviceVersionId,r.decision,r.comment,r.reviewerId,r.decidedAt]); return result.affectedRows === 1; }
  async getReview(versionId: string): Promise<Review | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_reviews WHERE service_version_id=?",[versionId]); const r=rows[0]; return r ? {serviceVersionId:r.service_version_id,decision:r.decision,comment:r.comment,reviewerId:r.reviewer_id,decidedAt:date(r.decided_at)} : null; }
  async upsertToolRuntime(r: ToolRuntime): Promise<void> { await this.executor.execute("INSERT INTO mcp_tool_runtime (project_id,original_name,status,suspended_reason,updated_at) VALUES (?,?,?,?,?) ON DUPLICATE KEY UPDATE status=VALUES(status),suspended_reason=VALUES(suspended_reason),updated_at=VALUES(updated_at)",[r.projectId,r.originalName,r.status,r.suspendedReason,r.updatedAt]); }
  async getToolRuntime(projectId: string,name: string): Promise<ToolRuntime | null> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_tool_runtime WHERE project_id=? AND original_name=?",[projectId,name]); const r=rows[0]; return r ? {projectId:r.project_id,originalName:r.original_name,status:r.status,suspendedReason:r.suspended_reason,updatedAt:date(r.updated_at)} : null; }
  async listToolRuntime(projectId: string): Promise<ToolRuntime[]> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_tool_runtime WHERE project_id=?",[projectId]); return rows.map((r)=>({projectId:r.project_id,originalName:r.original_name,status:r.status,suspendedReason:r.suspended_reason,updatedAt:date(r.updated_at)})); }
  async listCatalog(): Promise<CatalogEntry[]> {
    const [rows]=await this.executor.query<RowDataPacket[]>(`SELECT p.*,v.id v_id,v.project_id v_project_id,v.version_no,v.endpoint,v.protocol_version,v.credential_ciphertext,v.credential_key_id,v.review_status,v.risk_level v_risk_level,v.definition_hash,v.submitted_by,v.submitted_at,v.created_at v_created_at,t.id t_id,t.service_version_id,t.original_name,t.description t_description,t.input_schema,t.output_schema,t.risk_level t_risk_level FROM mcp_projects p JOIN mcp_service_versions v ON v.id=p.active_version_id JOIN mcp_tool_versions t ON t.service_version_id=v.id LEFT JOIN mcp_tool_runtime r ON r.project_id=p.id AND r.original_name=t.original_name WHERE p.status='active' AND p.health_status='healthy' AND v.review_status='approved' AND COALESCE(r.status,'active')='active' ORDER BY p.project_key,t.original_name`);
    return rows.map((r) => ({ publicName:`${r.project_key}__${r.original_name}`, project:projectFrom(r), version:versionFrom({id:r.v_id,project_id:r.v_project_id,version_no:r.version_no,endpoint:r.endpoint,protocol_version:r.protocol_version,credential_ciphertext:r.credential_ciphertext,credential_key_id:r.credential_key_id,review_status:r.review_status,risk_level:r.v_risk_level,definition_hash:r.definition_hash,submitted_by:r.submitted_by,submitted_at:r.submitted_at,created_at:r.v_created_at} as RowDataPacket), tool:toolFrom({id:r.t_id,service_version_id:r.service_version_id,original_name:r.original_name,description:r.t_description,input_schema:r.input_schema,output_schema:r.output_schema,risk_level:r.t_risk_level} as RowDataPacket) }));
  }
  async createCallCredential(c: CallCredential): Promise<void> { await this.executor.execute("INSERT INTO mcp_call_credentials (id,owner_id,credential_name,token_prefix,token_digest,expires_at,created_at,revoked_at) VALUES (?,?,?,?,?,?,?,?)",[c.id,c.ownerId,c.credentialName,c.tokenPrefix,c.tokenDigest,c.expiresAt,c.createdAt,c.revokedAt]); }
  async updateCallCredential(c: CallCredential): Promise<void> { await this.executor.execute("UPDATE mcp_call_credentials SET credential_name=?,expires_at=?,revoked_at=? WHERE id=?",[c.credentialName,c.expiresAt,c.revokedAt,c.id]); }
  async getCallCredentialByDigest(digest: Buffer): Promise<CallCredential | null> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_call_credentials WHERE token_digest=?",[digest]); return rows[0] ? credentialFrom(rows[0]) : null; }
  async getCallCredential(id: string): Promise<CallCredential | null> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_call_credentials WHERE id=?",[id]); return rows[0] ? credentialFrom(rows[0]) : null; }
  async listCallCredentials(ownerId: string): Promise<CallCredential[]> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_call_credentials WHERE owner_id=? ORDER BY created_at DESC",[ownerId]); return rows.map(credentialFrom); }
}
