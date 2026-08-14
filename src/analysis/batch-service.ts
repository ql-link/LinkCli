import { averageVector, cosineSimilarity, sha256, sceneOf } from "./similarity.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { ClusterJudge, QueryAssignmentDecision } from "./cluster-judge.js";
import type { AnalysisRepository } from "./repository.js";
import { NoopSkillCoverageResolver, defaultClusterDecisionSettings, defaultClusterThresholds, type AnalysisInput, type CandidateType, type ClusterDecisionSettings, type ClusterThresholds, type QueryCluster, type SkillCoverageResolver } from "./types.js";

export interface BatchResult { locked: boolean; read: number; analyzed: number; skipped: number; failed: number; candidates: number; }

function isQualitySuccess(input: AnalysisInput): boolean {
  if (input.settlementStatus !== "success" || input.calls.some((call) => call.outcome !== "success")) return false;
  const signals = input.behaviorSignals ?? {};
  return !signals.retried && !signals.abandoned && !signals.switchedPath && !signals.noOutput && !(typeof signals.retryCount === "number" && signals.retryCount > 0);
}

function candidateType(cluster: QueryCluster, thresholds: ClusterThresholds): CandidateType | null {
  const span = cluster.lastSeenAt.getTime() - cluster.firstSeenAt.getTime();
  // Embedding cohesion is an observation signal only. The final category decision is made by ClusterJudge.
  const base = cluster.sampleCount >= thresholds.minimumSamples && cluster.distinctActorCount >= thresholds.minimumActors && span >= thresholds.minimumSpanMs && cluster.inputCompleteness >= thresholds.minimumInputCompleteness;
  if (!base) return null;
  if (cluster.clusterType === "uncovered") return "uncovered_demand";
  const gapRatio = cluster.sampleCount === 0 ? 0 : cluster.coverageGapCount / cluster.sampleCount;
  if (cluster.coverageGapCount >= thresholds.minimumCoverageGapCount || gapRatio >= thresholds.minimumCoverageGapRatio) return "expand_skill";
  if (cluster.attemptedSkillCount > 0) return null;
  return cluster.successCount / cluster.sampleCount >= thresholds.minimumSuccessRate ? "new_skill" : null;
}

interface PreparedAssignment {
  vector: number[];
  cluster: QueryCluster | null;
  clusterKey: string;
  similarity: number;
  decisionType: "seed" | "exact_fingerprint" | "llm_existing" | "llm_new";
  decision: QueryAssignmentDecision;
  recalled: Array<{ clusterId: number; similarity: number }>;
}

export class AnalysisBatchService {
  private readonly thresholds: ClusterThresholds;
  private readonly candidateHandoffEnabled: boolean;
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly embeddings: EmbeddingProvider,
    private readonly judge: ClusterJudge,
    thresholds: Partial<ClusterThresholds> = {},
    private readonly coverage: SkillCoverageResolver = new NoopSkillCoverageResolver(),
    candidateHandoffEnabled?: boolean,
    decisionSettings: Partial<ClusterDecisionSettings> = {},
  ) {
    this.thresholds = { ...defaultClusterThresholds, ...thresholds };
    this.decisionSettings = { ...defaultClusterDecisionSettings, ...decisionSettings };
    this.candidateHandoffEnabled = candidateHandoffEnabled ?? (this.embeddings.candidateHandoffEnabled !== false && this.judge.candidateHandoffEnabled !== false);
  }
  private readonly decisionSettings: ClusterDecisionSettings;

  async runBatch(limit = 1_000, now = new Date()): Promise<BatchResult> {
    const result = await this.repository.withBatchLock(async (lockedRepository) => {
      const inputs = await lockedRepository.listPendingInputs(limit);
      const summary: BatchResult = { locked: true, read: inputs.length, analyzed: 0, skipped: 0, failed: 0, candidates: 0 };
      for (const input of inputs) {
        try {
          if (input.collectionTrust !== "trusted") {
            await lockedRepository.transaction(async (transaction) => { await transaction.markAnalyzed(input.id!, now); });
            summary.analyzed += 1; summary.skipped += 1; continue;
          }
          // Embedding 与 LLM 都是外部调用，必须在数据库事务外完成。单机批处理锁保证决策应用前类别集合不会被 rebuild 改写。
          const prepared = await this.prepareAssignment(lockedRepository, input);
          const outcome = await lockedRepository.transaction((transaction) => this.processInput(transaction, input, prepared, now));
          summary.analyzed += outcome.analyzed ? 1 : 0; summary.skipped += outcome.skipped ? 1 : 0; summary.candidates += outcome.candidate ? 1 : 0;
        } catch {
          summary.failed += 1;
        }
      }
      return summary;
    });
    return result ?? { locked: false, read: 0, analyzed: 0, skipped: 0, failed: 0, candidates: 0 };
  }

  private async prepareAssignment(repository: AnalysisRepository, input: AnalysisInput): Promise<PreparedAssignment> {
    const type = input.modulePathHash ? "normal" : "uncovered";
    const candidates = await repository.listCandidateClusters(type, input.projectScope, input.modulePathHash);
    const [vector] = await this.embeddings.embed([input.queryText]);
    if (!vector) throw new Error("Embedding provider returned no vector for input query");
    const clusterKey = sha256(`${type}\0${input.projectScope ?? ""}\0${input.modulePathHash ?? ""}\0${this.embeddings.modelVersion}\0${this.judge.modelVersion}\0${input.queryFingerprint}`);
    const eligible = candidates.filter((cluster) => cluster.embeddingModelVersion === this.embeddings.modelVersion && cluster.centroidVector);
    const exact = eligible.find((cluster) => cluster.clusterKey === clusterKey);
    if (exact) {
      return { vector,cluster:exact,clusterKey,similarity:1,decisionType:"exact_fingerprint",decision:{clusterId:exact.id,confidence:1,reason:"Exact normalized Query fingerprint"},recalled:[{clusterId:exact.id,similarity:1}] };
    }
    const recalled = eligible
      .map((cluster) => ({ cluster, similarity: cosineSimilarity(vector, cluster.centroidVector!) }))
      .filter((item) => item.similarity >= this.decisionSettings.minimumRecallSimilarity)
      .sort((a, b) => b.similarity - a.similarity)
      .slice(0, this.decisionSettings.recallTopK);
    if (!recalled.length) {
      return { vector,cluster:null,clusterKey,similarity:1,decisionType:"seed",decision:{clusterId:null,confidence:1,reason:"No candidate category was recalled in the deterministic bucket"},recalled:[] };
    }
    const evidence = await Promise.all(recalled.map(async ({cluster}) => ({
      clusterId: cluster.id,
      representativeQueries: await repository.listRepresentativeQueries(cluster.id, this.decisionSettings.representativeQueryLimit),
    })));
    const decision = await this.judge.assign({ query: input.queryText, candidates: evidence });
    const chosen = decision.clusterId === null ? null : recalled.find((item) => item.cluster.id === decision.clusterId);
    if (decision.clusterId !== null && !chosen) throw new Error("Cluster judge selected a category outside Top-K recall");
    return {
      vector,cluster:chosen?.cluster??null,clusterKey,similarity:chosen?.similarity??1,
      decisionType:chosen?"llm_existing":"llm_new",decision,
      recalled:recalled.map((item)=>({clusterId:item.cluster.id,similarity:item.similarity})),
    };
  }

  private async processInput(repository: AnalysisRepository, input: AnalysisInput, prepared: PreparedAssignment, now: Date): Promise<{ analyzed: boolean; skipped: boolean; candidate: boolean }> {
    if (input.id === undefined) throw new Error("Persisted analysis input must have an id");
    const type = input.modulePathHash ? "normal" : "uncovered";
    const vector = prepared.vector;
    let cluster = prepared.cluster;
    if (!cluster) {
      cluster = await repository.createCluster({ clusterKey:prepared.clusterKey,clusterType:type,projectScope:input.projectScope,modulePathHash:input.modulePathHash,modulePath:input.modulePath,
        representativeEventId:input.eventId,representativeQuery:input.queryText,status:"observing",mergedIntoClusterId:null,sampleCount:0,distinctActorCount:0,successCount:0,coverageGapCount:0,attemptedSkillCount:0,semanticCohesion:0,inputCompleteness:0,centroidVector:vector,embeddingModelVersion:this.embeddings.modelVersion,firstSeenAt:input.occurredAt,lastSeenAt:input.occurredAt,version:0 });
    }
    const scene = sceneOf(input.calls);
    const qualitySuccess = isQualitySuccess(input);
    const inserted = await repository.addMember({ clusterId:cluster.id,analysisInputId:input.id,semanticSimilarity:prepared.similarity,queryVector:vector,sceneType:scene?.type??null,thresholdEligible:true,qualitySuccess,exclusionReason:null });
    if (!inserted) { await repository.markAnalyzed(input.id, now); return { analyzed: true, skipped: true, candidate: false }; }
    if (scene) await repository.upsertScene({ clusterId:cluster.id,sceneKey:scene.key,sceneType:scene.type,toolPath:scene.toolPath,riskLevel:scene.risk,succeeded:qualitySuccess,occurredAt:input.occurredAt });
    if (input.attemptedSkillId) {
      const coverage = await this.coverage.evaluate(input);
      if (coverage && !coverage.covered) await repository.addCoverageGap({ clusterId:cluster.id,analysisInputId:input.id,attemptedSkillId:input.attemptedSkillId,attemptedSkillVersion:input.attemptedSkillVersion,gapType:coverage.gapType??"not_covered",evidence:coverage.evidence??{} });
    }
    const memberVectors = await repository.listMemberVectors(cluster.id);
    if (memberVectors.length) await repository.updateCentroid(cluster.id, averageVector(memberVectors), this.embeddings.modelVersion);
    const current = await repository.recalculateCluster(cluster.id);
    await repository.appendScore(current.id,current.version,"cluster_assignment",prepared.decision.confidence,{
      inputId:input.id,decisionType:prepared.decisionType,judgeModelVersion:this.judge.modelVersion,reason:prepared.decision.reason,recalled:prepared.recalled,
    });
    await repository.appendScore(current.id,current.version,"cluster_quality",current.semanticCohesion,{ sampleCount:current.sampleCount,distinctActorCount:current.distinctActorCount,inputCompleteness:current.inputCompleteness,successRate:current.sampleCount?current.successCount/current.sampleCount:0,coverageGapCount:current.coverageGapCount });
    // 非语义兜底只用于影子观察。即使统计门槛碰巧满足，也不能把字面近似类别交给 L4。
    const typeToSend = this.candidateHandoffEnabled && this.embeddings.candidateHandoffEnabled !== false && this.judge.candidateHandoffEnabled !== false ? candidateType(current,this.thresholds) : null;
    let handedOff = false;
    if (typeToSend) {
      const scenes = await repository.listScenes(current.id);
      const eventId = sha256(`l3-candidate\0${current.id}\0${current.version}\0${typeToSend}`);
      handedOff = await repository.handOffCandidate(current.id,{eventId,clusterId:current.id,clusterVersion:current.version,candidateType:typeToSend,payload:{clusterKey:current.clusterKey,clusterType:current.clusterType,projectScope:current.projectScope,modulePath:current.modulePath,representativeQuery:current.representativeQuery,sampleCount:current.sampleCount,distinctActorCount:current.distinctActorCount,successRate:current.sampleCount?current.successCount/current.sampleCount:0,semanticCohesion:current.semanticCohesion,inputCompleteness:current.inputCompleteness,coverageGapCount:current.coverageGapCount,attemptedSkillCount:current.attemptedSkillCount,scenes}});
    }
    await repository.markAnalyzed(input.id, now);
    return { analyzed: true, skipped: false, candidate: handedOff };
  }
}
