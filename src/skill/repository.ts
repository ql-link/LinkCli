import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from "mysql2/promise";
import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";
import type { Skill, SkillCandidateType, SkillDefinition, SkillRepository, SkillReview, SkillStatus, SkillToolDependency, SkillValidationJob, SkillValidationRun, SkillVersion, ValidationTrigger } from "./types.js";
import type { SkillDbExecutor } from "./types.js";

function clone<T>(value: T): T {
  if (value instanceof Date) return new Date(value) as T;
  if (Array.isArray(value)) return value.map((item) => clone(item)) as T;
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value as Record<string, unknown>).map(([key, item]) => [key, clone(item)])) as T;
  return value;
}

export class MemorySkillRepository implements SkillRepository {
  private readonly skills = new Map<string, Skill>();
  private readonly versions = new Map<string, SkillVersion>();
  private readonly validationRuns = new Map<string, SkillValidationRun>();
  private readonly reviews = new Map<string, SkillReview>();
  private readonly jobs = new Map<string, SkillValidationJob>();

  async createDraft(skill: Skill, version: SkillVersion): Promise<boolean> {
    if ([...this.skills.values()].some((item) => item.sourceClusterId === skill.sourceClusterId && item.sourceClusterVersion === skill.sourceClusterVersion && item.candidateType === skill.candidateType)) return false;
    this.skills.set(skill.id, clone(skill));
    this.versions.set(version.id, clone(version));
    return true;
  }
  async getSkill(id: string): Promise<Skill | null> { return clone(this.skills.get(id) ?? null); }
  async getVersion(id: string): Promise<SkillVersion | null> { return clone(this.versions.get(id) ?? null); }
  async listSkills(): Promise<Skill[]> { return clone([...this.skills.values()].sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime())); }
  async findBySource(clusterId: number, clusterVersion: number, candidateType: SkillCandidateType): Promise<Skill | null> { return clone([...this.skills.values()].find((item) => item.sourceClusterId === clusterId && item.sourceClusterVersion === clusterVersion && item.candidateType === candidateType) ?? null); }
  async createVersion(version: SkillVersion): Promise<boolean> { if ([...this.versions.values()].some((item) => item.skillId === version.skillId && item.versionNo === version.versionNo)) return false; this.versions.set(version.id, clone(version)); return true; }
  async updateSkill(skill: Skill): Promise<void> {
    const current = this.skills.get(skill.id);
    if (!current) throw new AppError("NOT_FOUND", "Skill not found", 404);
    if (skill.revision !== current.revision + 1) throw new AppError("CONFLICT", "Skill revision is stale", 409);
    this.skills.set(skill.id, clone(skill));
  }
  async createValidationRun(run: SkillValidationRun): Promise<boolean> {
    const key = `${run.skillVersionId}\0${run.trigger}\0${run.sampleSetHash}`;
    if (this.validationRuns.has(key)) return false;
    this.validationRuns.set(key, clone(run));
    return true;
  }
  async findValidationRun(skillVersionId: string, trigger: ValidationTrigger, sampleSetHash: string): Promise<SkillValidationRun | null> { return clone(this.validationRuns.get(`${skillVersionId}\0${trigger}\0${sampleSetHash}`) ?? null); }
  async createReview(review: SkillReview): Promise<boolean> { if (this.reviews.has(review.skillVersionId)) return false; this.reviews.set(review.skillVersionId, clone(review)); return true; }
  async getReview(skillVersionId: string): Promise<SkillReview | null> { return clone(this.reviews.get(skillVersionId) ?? null); }
  async enqueueValidation(job: SkillValidationJob): Promise<boolean> { if ([...this.jobs.values()].some((item) => item.skillVersionId === job.skillVersionId && item.trigger === job.trigger && ["pending", "running", "completed"].includes(item.status))) return false; this.jobs.set(job.id, clone(job)); return true; }
  async claimValidationJobs(workerId: string, now: Date, leaseMs: number, limit: number): Promise<SkillValidationJob[]> { const rows = [...this.jobs.values()].filter((job) => job.nextAttemptAt <= now && (job.status === "pending" || (job.status === "running" && (!job.leaseUntil || job.leaseUntil <= now)))).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime()).slice(0, limit); for (const job of rows) { job.status = "running"; job.attempts++; job.leaseOwner = workerId; job.leaseUntil = new Date(now.getTime() + leaseMs); job.updatedAt = now; } return clone(rows); }
  async completeValidationJob(jobId: string, workerId: string, at: Date): Promise<boolean> { const job = this.jobs.get(jobId); if (!job || job.status !== "running" || job.leaseOwner !== workerId) return false; job.status = "completed"; job.leaseOwner = null; job.leaseUntil = null; job.updatedAt = at; return true; }
  async failValidationJob(jobId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number, errorCode: string): Promise<boolean> { const job = this.jobs.get(jobId); if (!job || job.status !== "running" || job.leaseOwner !== workerId) return false; job.status = job.attempts >= maxAttempts ? "dead" : "pending"; job.leaseOwner = null; job.leaseUntil = null; job.nextAttemptAt = nextAttemptAt; job.lastError = errorCode; job.updatedAt = new Date(); return true; }
}

const asDate = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const json = <T>(value: unknown): T => typeof value === "string" ? JSON.parse(value) as T : value as T;
const isDuplicate = (error: unknown): boolean => Boolean(error && typeof error === "object" && (error as { code?: unknown }).code === "ER_DUP_ENTRY");

function skillFrom(row: RowDataPacket): Skill {
  return { id: String(row.id), skillKey: String(row.skill_key), sourceClusterId: Number(row.source_cluster_id), sourceClusterVersion: Number(row.source_cluster_version), candidateType: row.candidate_type as SkillCandidateType, status: row.status as SkillStatus, currentVersionId: row.current_version_id ?? null, exposurePercent: Number(row.exposure_percent ?? 0), revision: Number(row.revision), statusReason: row.status_reason ?? null, createdAt: asDate(row.created_at), updatedAt: asDate(row.updated_at) };
}
function versionFrom(row: RowDataPacket): SkillVersion {
  return { id: String(row.id), skillId: String(row.skill_id), versionNo: Number(row.version_no), definition: json<SkillDefinition>(row.definition), dependencySnapshot: json<SkillToolDependency[]>(row.dependency_snapshot), generatorModel: String(row.generator_model), sourceEventId: String(row.source_event_id), createdAt: asDate(row.created_at) };
}
function validationFrom(row: RowDataPacket): SkillValidationRun {
  return { id: String(row.id), skillId: String(row.skill_id), skillVersionId: String(row.skill_version_id), trigger: row.trigger as ValidationTrigger, sampleSetHash: String(row.sample_set_hash), verdict: row.verdict, replaySummary: json(row.replay_summary), databaseCheckSummary: json(row.database_check_summary), createdAt: asDate(row.created_at) };
}
function jobFrom(row: RowDataPacket): SkillValidationJob { return { id: String(row.id), skillId: String(row.skill_id), skillVersionId: String(row.skill_version_id), trigger: row.trigger_type as ValidationTrigger, status: row.status, attempts: Number(row.attempts), nextAttemptAt: asDate(row.next_attempt_at), leaseOwner: row.lease_owner ?? null, leaseUntil: row.lease_until ? asDate(row.lease_until) : null, lastError: row.last_error ?? null, createdAt: asDate(row.created_at), updatedAt: asDate(row.updated_at) }; }

export class MySqlSkillRepository implements SkillRepository {
  constructor(private readonly executor: SkillDbExecutor, private readonly pool?: Pool) {}
  private async transaction<T>(work: (executor: PoolConnection) => Promise<T>): Promise<T> {
    if (!this.pool) return work(this.executor as PoolConnection);
    const connection = await this.pool.getConnection();
    try { await connection.beginTransaction(); const result = await work(connection); await connection.commit(); return result; } catch (error) { await connection.rollback(); throw error; } finally { connection.release(); }
  }
  async createDraft(skill: Skill, version: SkillVersion): Promise<boolean> {
    if (this.pool) return this.transaction((executor) => new MySqlSkillRepository(executor).createDraft(skill, version));
    try {
      const [result] = await this.executor.execute<ResultSetHeader>("INSERT INTO mcp_skills (id,skill_key,source_cluster_id,source_cluster_version,candidate_type,status,current_version_id,exposure_percent,revision,status_reason,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)", [skill.id, skill.skillKey, skill.sourceClusterId, skill.sourceClusterVersion, skill.candidateType, skill.status, null, skill.exposurePercent, skill.revision, skill.statusReason, skill.createdAt, skill.updatedAt]);
      if (result.affectedRows !== 1) return false;
      await this.executor.execute("INSERT INTO mcp_skill_versions (id,skill_id,version_no,definition,dependency_snapshot,generator_model,source_event_id,created_at) VALUES (?,?,?,?,?,?,?,?)", [version.id, version.skillId, version.versionNo, JSON.stringify(version.definition), JSON.stringify(version.dependencySnapshot), version.generatorModel, version.sourceEventId, version.createdAt]);
      await this.executor.execute("UPDATE mcp_skills SET current_version_id=? WHERE id=?", [version.id, skill.id]);
      return true;
    } catch (error) {
      if (isDuplicate(error)) return false;
      throw error;
    }
  }
  async getSkill(id: string): Promise<Skill | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skills WHERE id=?", [id]); return rows[0] ? skillFrom(rows[0]) : null; }
  async getVersion(id: string): Promise<SkillVersion | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skill_versions WHERE id=?", [id]); return rows[0] ? versionFrom(rows[0]) : null; }
  async listSkills(): Promise<Skill[]> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skills ORDER BY created_at,id"); return rows.map(skillFrom); }
  async findBySource(clusterId: number, clusterVersion: number, candidateType: SkillCandidateType): Promise<Skill | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skills WHERE source_cluster_id=? AND source_cluster_version=? AND candidate_type=?", [clusterId, clusterVersion, candidateType]); return rows[0] ? skillFrom(rows[0]) : null; }
  async createVersion(version: SkillVersion): Promise<boolean> { try { const [result] = await this.executor.execute<ResultSetHeader>("INSERT INTO mcp_skill_versions (id,skill_id,version_no,definition,dependency_snapshot,generator_model,source_event_id,created_at) VALUES (?,?,?,?,?,?,?,?)", [version.id, version.skillId, version.versionNo, JSON.stringify(version.definition), JSON.stringify(version.dependencySnapshot), version.generatorModel, version.sourceEventId, version.createdAt]); return result.affectedRows === 1; } catch (error) { if (isDuplicate(error)) return false; throw error; } }
  async updateSkill(skill: Skill): Promise<void> {
    const [result] = await this.executor.execute<ResultSetHeader>("UPDATE mcp_skills SET status=?,current_version_id=?,exposure_percent=?,revision=?,status_reason=?,updated_at=? WHERE id=? AND revision=?", [skill.status, skill.currentVersionId, skill.exposurePercent, skill.revision, skill.statusReason, skill.updatedAt, skill.id, skill.revision - 1]);
    if (result.affectedRows !== 1) throw new AppError("CONFLICT", "Skill revision is stale", 409);
  }
  async createValidationRun(run: SkillValidationRun): Promise<boolean> {
    try {
      const [result] = await this.executor.execute<ResultSetHeader>("INSERT INTO mcp_skill_validation_runs (id,skill_id,skill_version_id,trigger_type,sample_set_hash,verdict,replay_summary,database_check_summary,created_at) VALUES (?,?,?,?,?,?,?,?,?)", [run.id, run.skillId, run.skillVersionId, run.trigger, run.sampleSetHash, run.verdict, JSON.stringify(run.replaySummary), JSON.stringify(run.databaseCheckSummary), run.createdAt]);
      return result.affectedRows === 1;
    } catch (error) { if (isDuplicate(error)) return false; throw error; }
  }
  async findValidationRun(skillVersionId: string, trigger: ValidationTrigger, sampleSetHash: string): Promise<SkillValidationRun | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skill_validation_runs WHERE skill_version_id=? AND trigger_type=? AND sample_set_hash=?", [skillVersionId, trigger, sampleSetHash]); return rows[0] ? validationFrom(rows[0]) : null; }
  async createReview(review: SkillReview): Promise<boolean> { const [result] = await this.executor.execute<ResultSetHeader>("INSERT IGNORE INTO mcp_skill_reviews (id,skill_id,skill_version_id,decision,comment,reviewer_id,decided_at) VALUES (?,?,?,?,?,?,?)", [review.id, review.skillId, review.skillVersionId, review.decision, review.comment, review.reviewerId, review.decidedAt]); return result.affectedRows === 1; }
  async getReview(skillVersionId: string): Promise<SkillReview | null> { const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skill_reviews WHERE skill_version_id=?", [skillVersionId]); if (!rows[0]) return null; return { id: String(rows[0].id), skillId: String(rows[0].skill_id), skillVersionId: String(rows[0].skill_version_id), decision: rows[0].decision, comment: rows[0].comment ?? null, reviewerId: String(rows[0].reviewer_id), decidedAt: asDate(rows[0].decided_at) }; }
  async enqueueValidation(job: SkillValidationJob): Promise<boolean> { const [result] = await this.executor.execute<ResultSetHeader>("INSERT IGNORE INTO mcp_skill_validation_jobs (id,skill_id,skill_version_id,trigger_type,status,attempts,next_attempt_at,last_error,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?)", [job.id, job.skillId, job.skillVersionId, job.trigger, job.status, job.attempts, job.nextAttemptAt, job.lastError, job.createdAt, job.updatedAt]); return result.affectedRows === 1; }
  async claimValidationJobs(workerId: string, now: Date, leaseMs: number, limit: number): Promise<SkillValidationJob[]> { if (this.pool) return this.transaction((executor) => new MySqlSkillRepository(executor).claimValidationJobs(workerId, now, leaseMs, limit)); const [rows] = await this.executor.query<RowDataPacket[]>("SELECT * FROM mcp_skill_validation_jobs WHERE next_attempt_at<=? AND (status='pending' OR (status='running' AND (lease_until IS NULL OR lease_until<=?))) ORDER BY created_at,id LIMIT ? FOR UPDATE SKIP LOCKED", [now, now, limit]); if (!rows.length) return []; const ids = rows.map((row) => row.id); await this.executor.execute(`UPDATE mcp_skill_validation_jobs SET status='running',attempts=attempts+1,lease_owner=?,lease_until=?,updated_at=? WHERE id IN (${ids.map(() => "?").join(",")})`, [workerId, new Date(now.getTime() + leaseMs), now, ...ids]); return rows.map((row) => jobFrom({ ...row, status: "running", attempts: Number(row.attempts) + 1, lease_owner: workerId, lease_until: new Date(now.getTime() + leaseMs), updated_at: now } as RowDataPacket)); }
  async completeValidationJob(jobId: string, workerId: string, at: Date): Promise<boolean> { const [result] = await this.executor.execute<ResultSetHeader>("UPDATE mcp_skill_validation_jobs SET status='completed',lease_owner=NULL,lease_until=NULL,updated_at=? WHERE id=? AND status='running' AND lease_owner=?", [at, jobId, workerId]); return result.affectedRows === 1; }
  async failValidationJob(jobId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number, errorCode: string): Promise<boolean> { const [result] = await this.executor.execute<ResultSetHeader>("UPDATE mcp_skill_validation_jobs SET status=IF(attempts>=?,'dead','pending'),next_attempt_at=?,lease_owner=NULL,lease_until=NULL,last_error=?,updated_at=CURRENT_TIMESTAMP(6) WHERE id=? AND status='running' AND lease_owner=?", [maxAttempts, nextAttemptAt, errorCode, jobId, workerId]); return result.affectedRows === 1; }
}

export const newSkillId = (): string => randomUUID();
