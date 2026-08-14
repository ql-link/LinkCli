export type SettlementStatus = "success" | "partial" | "failed" | "unmatched" | "zero_call";
export type CollectionTrust = "trusted" | "suspect" | "missing";
export type ClusterType = "normal" | "uncovered";
export type ClusterStatus = "observing" | "candidate_ready" | "handed_off" | "cooling" | "merged" | "retired";
export type CandidateType = "new_skill" | "expand_skill" | "uncovered_demand";

export interface AnalysisCall {
  sequence: number;
  projectId: string;
  moduleId?: string;
  toolName: string;
  operation?: string;
  parameterKeys: string[];
  outcome: "success" | "error";
}

export interface AnalysisInput {
  id?: number;
  eventId: string;
  turnId: string;
  settlementVersion: number;
  actorHash: string;
  queryText: string;
  queryFingerprint: string;
  projectScope: string | null;
  modulePathHash: string | null;
  modulePath: string[] | null;
  calls: AnalysisCall[];
  behaviorSignals: Record<string, boolean | number | string> | null;
  settlementStatus: SettlementStatus;
  collectionTrust: CollectionTrust;
  attemptedSkillId: string | null;
  attemptedSkillVersion: string | null;
  occurredAt: Date;
  analyzedAt: Date | null;
}

export interface QueryCluster {
  id: number;
  clusterKey: string;
  clusterType: ClusterType;
  projectScope: string | null;
  modulePathHash: string | null;
  modulePath: string[] | null;
  representativeEventId: string;
  representativeQuery: string;
  status: ClusterStatus;
  mergedIntoClusterId: number | null;
  sampleCount: number;
  distinctActorCount: number;
  successCount: number;
  coverageGapCount: number;
  attemptedSkillCount: number;
  semanticCohesion: number;
  inputCompleteness: number;
  /** 类别语义中心：成员向量算术平均，决定聚类判断；representativeQuery 只做展示，两者不互相替代 */
  centroidVector: number[] | null;
  /** `<provider>:<model_name>:<dim>`，模型切换后据此分批重算 */
  embeddingModelVersion: string | null;
  firstSeenAt: Date;
  lastSeenAt: Date;
  version: number;
}

export interface ClusterMember {
  clusterId: number;
  analysisInputId: number;
  semanticSimilarity: number;
  /** 该成员的 Query 向量，供质心增量重算和 ClusterRebuildJob 使用 */
  queryVector: number[] | null;
  sceneType: string | null;
  thresholdEligible: boolean;
  qualitySuccess: boolean;
  exclusionReason: string | null;
}

export interface ClusterScene {
  clusterId: number;
  sceneKey: string;
  sceneType: string;
  toolPath: Array<{ projectId: string; moduleId: string | null; toolName: string; operation: string | null }>;
  riskLevel: "low" | "medium" | "high";
  succeeded: boolean;
  occurredAt: Date;
}

export interface CoverageGap {
  clusterId: number;
  analysisInputId: number;
  attemptedSkillId: string;
  attemptedSkillVersion: string | null;
  gapType: "not_covered" | "partial_coverage" | "mismatch" | "execution_failure";
  evidence: Record<string, unknown>;
}

export interface CandidateEvent {
  eventId: string;
  clusterId: number;
  clusterVersion: number;
  candidateType: CandidateType;
  payload: Record<string, unknown>;
}

export interface ClusterThresholds {
  minimumSamples: number;
  minimumActors: number;
  minimumSpanMs: number;
  minimumInputCompleteness: number;
  minimumCohesion: number;
  minimumSuccessRate: number;
  minimumCoverageGapCount: number;
  minimumCoverageGapRatio: number;
  /** 高方差复核所需的最小成员数。归类和合并由 ClusterJudge 决定，不再使用 cosine 硬阈值。 */
  minimumRebuildMembers: number;
}

export interface ClusterDecisionSettings {
  /** Embedding 在同一确定性桶内召回给 LLM 的候选类别数。 */
  recallTopK: number;
  /** 每个候选类别提供给 LLM 的真实代表 Query 数。 */
  representativeQueryLimit: number;
  /** 只用于召回剪枝，不是最终归类或合并阈值。 */
  minimumRecallSimilarity: number;
}

export const defaultClusterThresholds: ClusterThresholds = {
  minimumSamples: 20,
  minimumActors: 5,
  minimumSpanMs: 3 * 24 * 60 * 60 * 1_000,
  minimumInputCompleteness: 0.95,
  minimumCohesion: 0.82,
  minimumSuccessRate: 0.9,
  minimumCoverageGapCount: 5,
  minimumCoverageGapRatio: 0.2,
  minimumRebuildMembers: 3,
};

export const defaultClusterDecisionSettings: ClusterDecisionSettings = {
  recallTopK: 5,
  representativeQueryLimit: 3,
  minimumRecallSimilarity: 0,
};

export interface SkillCoverageResult {
  covered: boolean;
  gapType?: CoverageGap["gapType"];
  evidence?: Record<string, unknown>;
}

export interface SkillCoverageResolver {
  evaluate(input: AnalysisInput): Promise<SkillCoverageResult | null>;
}

export class NoopSkillCoverageResolver implements SkillCoverageResolver {
  async evaluate(): Promise<null> { return null; }
}
