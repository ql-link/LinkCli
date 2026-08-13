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
  sampleCount: number;
  distinctActorCount: number;
  successCount: number;
  coverageGapCount: number;
  attemptedSkillCount: number;
  semanticCohesion: number;
  inputCompleteness: number;
  firstSeenAt: Date;
  lastSeenAt: Date;
  version: number;
}

export interface ClusterMember {
  clusterId: number;
  analysisInputId: number;
  semanticSimilarity: number;
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
  joinSimilarity: number;
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
  joinSimilarity: 0.82,
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
