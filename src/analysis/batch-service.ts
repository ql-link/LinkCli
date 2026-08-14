import { averageVector, cosineSimilarity, sha256, sceneOf } from "./similarity.js";
import type { EmbeddingProvider } from "./embedding-provider.js";
import type { AnalysisRepository } from "./repository.js";
import { NoopSkillCoverageResolver, defaultClusterThresholds, type AnalysisInput, type CandidateType, type ClusterThresholds, type QueryCluster, type SkillCoverageResolver } from "./types.js";

export interface BatchResult { locked: boolean; read: number; analyzed: number; skipped: number; failed: number; candidates: number; }

function isQualitySuccess(input: AnalysisInput): boolean {
  if (input.settlementStatus !== "success" || input.calls.some((call) => call.outcome !== "success")) return false;
  const signals = input.behaviorSignals ?? {};
  return !signals.retried && !signals.abandoned && !signals.switchedPath && !signals.noOutput && !(typeof signals.retryCount === "number" && signals.retryCount > 0);
}

function candidateType(cluster: QueryCluster, thresholds: ClusterThresholds): CandidateType | null {
  const span = cluster.lastSeenAt.getTime() - cluster.firstSeenAt.getTime();
  const base = cluster.sampleCount >= thresholds.minimumSamples && cluster.distinctActorCount >= thresholds.minimumActors && span >= thresholds.minimumSpanMs && cluster.inputCompleteness >= thresholds.minimumInputCompleteness && cluster.semanticCohesion >= thresholds.minimumCohesion;
  if (!base) return null;
  if (cluster.clusterType === "uncovered") return "uncovered_demand";
  const gapRatio = cluster.sampleCount === 0 ? 0 : cluster.coverageGapCount / cluster.sampleCount;
  if (cluster.coverageGapCount >= thresholds.minimumCoverageGapCount || gapRatio >= thresholds.minimumCoverageGapRatio) return "expand_skill";
  if (cluster.attemptedSkillCount > 0) return null;
  return cluster.successCount / cluster.sampleCount >= thresholds.minimumSuccessRate ? "new_skill" : null;
}

export class AnalysisBatchService {
  private readonly thresholds: ClusterThresholds;
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly embeddings: EmbeddingProvider,
    thresholds: Partial<ClusterThresholds> = {},
    private readonly coverage: SkillCoverageResolver = new NoopSkillCoverageResolver(),
  ) {
    this.thresholds = { ...defaultClusterThresholds, ...thresholds };
  }

  async runBatch(limit = 1_000, now = new Date()): Promise<BatchResult> {
    const result = await this.repository.withBatchLock(async (lockedRepository) => {
      const inputs = await lockedRepository.listPendingInputs(limit);
      const summary: BatchResult = { locked: true, read: inputs.length, analyzed: 0, skipped: 0, failed: 0, candidates: 0 };
      for (const input of inputs) {
        try {
          const outcome = await lockedRepository.transaction((transaction) => this.processInput(transaction, input, now));
          summary.analyzed += outcome.analyzed ? 1 : 0; summary.skipped += outcome.skipped ? 1 : 0; summary.candidates += outcome.candidate ? 1 : 0;
        } catch {
          summary.failed += 1;
        }
      }
      return summary;
    });
    return result ?? { locked: false, read: 0, analyzed: 0, skipped: 0, failed: 0, candidates: 0 };
  }

  private async processInput(repository: AnalysisRepository, input: AnalysisInput, now: Date): Promise<{ analyzed: boolean; skipped: boolean; candidate: boolean }> {
    if (input.id === undefined) throw new Error("Persisted analysis input must have an id");
    if (input.collectionTrust !== "trusted") { await repository.markAnalyzed(input.id, now); return { analyzed: true, skipped: true, candidate: false }; }
    const type = input.modulePathHash ? "normal" : "uncovered";
    const candidates = await repository.listCandidateClusters(type, input.projectScope, input.modulePathHash);
    const vectors = await this.embeddings.embed([input.queryText]);
    const vector = vectors[0];
    if (!vector) throw new Error("Embedding provider returned no vector for input query");
    // 只与使用同一 Embedding 模型版本的类别比较；跨版本的质心向量不在同一空间，比较无意义（MCPSTAT-1-L3 §6.3）。
    const eligible = candidates.filter((cluster) => cluster.embeddingModelVersion === this.embeddings.modelVersion && cluster.centroidVector);
    const ranked = eligible.map((cluster) => ({ cluster, similarity: cosineSimilarity(vector, cluster.centroidVector!) })).sort((a, b) => b.similarity - a.similarity);
    let similarity = ranked[0]?.similarity ?? 1;
    let cluster = ranked[0] && ranked[0].similarity >= this.thresholds.joinSimilarity ? ranked[0].cluster : null;
    if (!cluster) {
      similarity = 1;
      cluster = await repository.createCluster({ clusterKey:sha256(`${type}\0${input.projectScope ?? ""}\0${input.modulePathHash ?? ""}\0${input.queryFingerprint}`),clusterType:type,projectScope:input.projectScope,modulePathHash:input.modulePathHash,modulePath:input.modulePath,
        representativeEventId:input.eventId,representativeQuery:input.queryText,status:"observing",mergedIntoClusterId:null,sampleCount:0,distinctActorCount:0,successCount:0,coverageGapCount:0,attemptedSkillCount:0,semanticCohesion:0,inputCompleteness:0,centroidVector:vector,embeddingModelVersion:this.embeddings.modelVersion,firstSeenAt:input.occurredAt,lastSeenAt:input.occurredAt,version:0 });
    }
    const scene = sceneOf(input.calls);
    const qualitySuccess = isQualitySuccess(input);
    const inserted = await repository.addMember({ clusterId:cluster.id,analysisInputId:input.id,semanticSimilarity:similarity,queryVector:vector,sceneType:scene?.type??null,thresholdEligible:true,qualitySuccess,exclusionReason:null });
    if (!inserted) { await repository.markAnalyzed(input.id, now); return { analyzed: true, skipped: true, candidate: false }; }
    if (scene) await repository.upsertScene({ clusterId:cluster.id,sceneKey:scene.key,sceneType:scene.type,toolPath:scene.toolPath,riskLevel:scene.risk,succeeded:qualitySuccess,occurredAt:input.occurredAt });
    if (input.attemptedSkillId) {
      const coverage = await this.coverage.evaluate(input);
      if (coverage && !coverage.covered) await repository.addCoverageGap({ clusterId:cluster.id,analysisInputId:input.id,attemptedSkillId:input.attemptedSkillId,attemptedSkillVersion:input.attemptedSkillVersion,gapType:coverage.gapType??"not_covered",evidence:coverage.evidence??{} });
    }
    const memberVectors = await repository.listMemberVectors(cluster.id);
    if (memberVectors.length) await repository.updateCentroid(cluster.id, averageVector(memberVectors), this.embeddings.modelVersion);
    const current = await repository.recalculateCluster(cluster.id);
    await repository.appendScore(current.id,current.version,"cluster_quality",current.semanticCohesion,{ sampleCount:current.sampleCount,distinctActorCount:current.distinctActorCount,inputCompleteness:current.inputCompleteness,successRate:current.sampleCount?current.successCount/current.sampleCount:0,coverageGapCount:current.coverageGapCount });
    const typeToSend = candidateType(current,this.thresholds);
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
