import type { Pool, PoolConnection } from "mysql2/promise";
import type { JsonObject } from "../domain.js";

export type SkillStatus = "draft" | "validating" | "pending_review" | "canary" | "active" | "paused" | "degraded" | "retired";
export type SkillCandidateType = "new_skill" | "expand_skill" | "uncovered_demand";
export type ValidationTrigger = "generation" | "revision" | "dependency_change" | "runtime_anomaly" | "manual";
export type ValidationVerdict = "passed" | "failed" | "insufficient" | "cluster_error";

export interface SkillToolDependency {
  projectId: string;
  serviceVersionId: string | null;
  toolVersionId: string | null;
  originalName: string;
}

export interface SkillStep {
  id: string;
  tool: SkillToolDependency;
  inputMapping: JsonObject;
  outputKey: string | null;
}

export interface SkillValidationCase {
  id: string;
  query: string;
  input: JsonObject;
  expected: JsonObject | null;
}

export interface SkillDefinition {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  steps: SkillStep[];
  validationCases: SkillValidationCase[];
}

export interface Skill {
  id: string;
  skillKey: string;
  sourceClusterId: number;
  sourceClusterVersion: number;
  candidateType: SkillCandidateType;
  status: SkillStatus;
  currentVersionId: string | null;
  exposurePercent: number;
  revision: number;
  statusReason: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillVersion {
  id: string;
  skillId: string;
  versionNo: number;
  definition: SkillDefinition;
  dependencySnapshot: SkillToolDependency[];
  generatorModel: string;
  sourceEventId: string;
  createdAt: Date;
}

export interface SkillValidationRun {
  id: string;
  skillId: string;
  skillVersionId: string;
  trigger: ValidationTrigger;
  sampleSetHash: string;
  verdict: ValidationVerdict;
  replaySummary: JsonObject;
  databaseCheckSummary: JsonObject;
  createdAt: Date;
}

export type SkillValidationJobStatus = "pending" | "running" | "completed" | "dead";
export interface SkillValidationJob {
  id: string;
  skillId: string;
  skillVersionId: string;
  trigger: ValidationTrigger;
  status: SkillValidationJobStatus;
  attempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseUntil: Date | null;
  lastError: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface SkillReview {
  id: string;
  skillId: string;
  skillVersionId: string;
  decision: "approved" | "rejected";
  comment: string | null;
  reviewerId: string;
  decidedAt: Date;
}

export interface SkillCandidate {
  eventId: string;
  clusterId: number;
  clusterVersion: number;
  candidateType: SkillCandidateType;
  payload: JsonObject;
  receivedAt?: Date;
}

export interface SkillValidationObservation {
  verdict: ValidationVerdict;
  replay: JsonObject;
  databaseCheck: JsonObject;
}

export interface SkillCaseExecutor {
  execute(sample: SkillValidationCase, version: SkillVersion): Promise<SkillValidationObservation>;
}

export interface AuthorityChecker {
  check(sample: SkillValidationCase, version: SkillVersion, replay: JsonObject): Promise<{ verdict: ValidationVerdict; summary: JsonObject }>;
}

export interface SkillRepository {
  createDraft(skill: Skill, version: SkillVersion): Promise<boolean>;
  getSkill(id: string): Promise<Skill | null>;
  getVersion(id: string): Promise<SkillVersion | null>;
  listSkills(): Promise<Skill[]>;
  findBySource(clusterId: number, clusterVersion: number, candidateType: SkillCandidateType): Promise<Skill | null>;
  createVersion(version: SkillVersion): Promise<boolean>;
  updateSkill(skill: Skill): Promise<void>;
  createValidationRun(run: SkillValidationRun): Promise<boolean>;
  findValidationRun(skillVersionId: string, trigger: ValidationTrigger, sampleSetHash: string): Promise<SkillValidationRun | null>;
  listValidationRuns(skillId: string): Promise<SkillValidationRun[]>;
  createReview(review: SkillReview): Promise<boolean>;
  getReview(skillVersionId: string): Promise<SkillReview | null>;
  enqueueValidation(job: SkillValidationJob): Promise<boolean>;
  findActiveValidationJob(skillVersionId: string, trigger: ValidationTrigger): Promise<SkillValidationJob | null>;
  listValidationJobs(skillId: string): Promise<SkillValidationJob[]>;
  claimValidationJobs(workerId: string, now: Date, leaseMs: number, limit: number): Promise<SkillValidationJob[]>;
  completeValidationJob(jobId: string, workerId: string, at: Date): Promise<boolean>;
  failValidationJob(jobId: string, workerId: string, nextAttemptAt: Date, maxAttempts: number, errorCode: string): Promise<boolean>;
}

export type SkillDbExecutor = Pool | PoolConnection;
