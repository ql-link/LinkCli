import { averageVector, cosineSimilarity } from "./similarity.js";
import type { ClusterJudge } from "./cluster-judge.js";
import type { AnalysisRepository } from "./repository.js";
import { defaultClusterDecisionSettings, type ClusterDecisionSettings, type ClusterThresholds, type QueryCluster } from "./types.js";

export interface RebuildResult { buckets: number; judgedPairs: number; merged: number; manualReview: number; }

function bucketKeyOf(cluster: QueryCluster): string {
  return `${cluster.clusterType}\0${cluster.projectScope ?? ""}\0${cluster.modulePathHash ?? ""}\0${cluster.embeddingModelVersion ?? ""}`;
}

/**
 * 周期性对每个确定性桶内“观察中”的类别做复核。Embedding 仅召回 Top-K 类别对；最终是否合并
 * 由 ClusterJudge 阅读两组真实代表 Query 后决定，不能再用质心 cosine 阈值直接合并。
 * 拆分（类别内部方差过高）仅记录评分历史供人工复核，不在本版本自动执行。
 */
export class ClusterRebuildJob {
  private readonly decisionSettings: ClusterDecisionSettings;
  constructor(
    private readonly repository: AnalysisRepository,
    private readonly judge: ClusterJudge,
    private readonly thresholds: ClusterThresholds,
    decisionSettings: Partial<ClusterDecisionSettings> = {},
  ) { this.decisionSettings = { ...defaultClusterDecisionSettings, ...decisionSettings }; }

  async runOnce(): Promise<RebuildResult> {
    const result = await this.repository.withBatchLock(async (repository) => {
      const clusters = await repository.listClusters();
      const eligible = clusters.filter((cluster) => cluster.status === "observing" && cluster.centroidVector && cluster.centroidVector.length > 0);
      const buckets = new Map<string, QueryCluster[]>();
      for (const cluster of eligible) {
        const key = bucketKeyOf(cluster);
        const list = buckets.get(key) ?? [];
        list.push(cluster);
        buckets.set(key, list);
      }
      let judgedPairs = 0;
      let merged = 0;
      let manualReview = 0;
      for (const group of buckets.values()) {
        const result = group.length < 2 ? { clusters:group,judgedPairs:0,merged:0 } : await this.consolidateBucket(repository, group);
        judgedPairs += result.judgedPairs;
        merged += result.merged;
        const consolidated = result.clusters;
        for (const cluster of consolidated) manualReview += await this.markHighVariance(repository, cluster);
      }
      return { buckets: buckets.size, judgedPairs, merged, manualReview };
    });
    return result ?? { buckets: 0, judgedPairs: 0, merged: 0, manualReview: 0 };
  }

  private async consolidateBucket(repository: AnalysisRepository, initial: QueryCluster[]): Promise<{clusters:QueryCluster[];judgedPairs:number;merged:number}> {
    const pairMap = new Map<string,{left:QueryCluster;right:QueryCluster;similarity:number}>();
    for (const left of initial) {
      const neighbors = initial.filter((right)=>right.id!==left.id)
        .map((right)=>({right,similarity:cosineSimilarity(left.centroidVector!,right.centroidVector!)}))
        .filter((item)=>item.similarity>=this.decisionSettings.minimumRecallSimilarity)
        .sort((a,b)=>b.similarity-a.similarity).slice(0,this.decisionSettings.recallTopK);
      for (const {right,similarity} of neighbors) {
        const [first,second]=left.id<right.id?[left,right]:[right,left];
        pairMap.set(`${first.id}:${second.id}`,{left:first,right:second,similarity});
      }
    }
    const pairs=[...pairMap.values()].sort((a,b)=>b.similarity-a.similarity);
    const active=new Map(initial.map((cluster)=>[cluster.id,cluster]));
    let judgedPairs=0;let merged=0;
    for(const pair of pairs){
      const a=active.get(pair.left.id);const b=active.get(pair.right.id);
      if(!a||!b)continue;
      const [leftQueries,rightQueries]=await Promise.all([
        repository.listRepresentativeQueries(a.id,this.decisionSettings.representativeQueryLimit),
        repository.listRepresentativeQueries(b.id,this.decisionSettings.representativeQueryLimit),
      ]);
      const decision=await this.judge.shouldMerge({left:{clusterId:a.id,representativeQueries:leftQueries},right:{clusterId:b.id,representativeQueries:rightQueries}});
      judgedPairs+=1;
      await repository.appendScore(a.id,a.version,"cluster_merge_judgement",decision.confidence,{
        otherClusterId:b.id,judgeModelVersion:this.judge.modelVersion,sameDemand:decision.sameDemand,reason:decision.reason,recallSimilarity:pair.similarity,
      });
      if(!decision.sameDemand)continue;
      const target = a.sampleCount >= b.sampleCount ? a : b;
      const source = target === a ? b : a;
      const recalculated = await repository.transaction(async (transaction) => {
        await transaction.mergeClusters(target.id, source.id);
        const vectors = await transaction.listMemberVectors(target.id);
        const centroid = vectors.length ? averageVector(vectors) : target.centroidVector;
        if (centroid && target.embeddingModelVersion) await transaction.updateCentroid(target.id, centroid, target.embeddingModelVersion);
        const current = await transaction.recalculateCluster(target.id);
        await transaction.appendScore(current.id,current.version,"cluster_merge",decision.confidence,{mergedClusterId:source.id,mergedClusterKey:source.clusterKey,judgeModelVersion:this.judge.modelVersion,reason:decision.reason,recallSimilarity:pair.similarity,modelVersion:target.embeddingModelVersion});
        return { ...current, centroidVector:centroid, embeddingModelVersion:target.embeddingModelVersion };
      });
      active.delete(source.id);active.delete(target.id);active.set(recalculated.id,recalculated);merged+=1;
    }
    return{clusters:[...active.values()],judgedPairs,merged};
  }

  private async markHighVariance(repository: AnalysisRepository, cluster: QueryCluster): Promise<number> {
    const vectors = await repository.listMemberVectors(cluster.id);
    if (vectors.length < this.thresholds.minimumRebuildMembers || !cluster.embeddingModelVersion) return 0;
    const centroid = averageVector(vectors);
    const similarities = vectors.map((vector) => cosineSimilarity(vector, centroid));
    const cohesion = similarities.reduce((sum, value) => sum + value, 0) / similarities.length;
    if (cohesion >= this.thresholds.minimumCohesion) return 0;
    await repository.appendScore(cluster.id,cluster.version,"cluster_split_review",cohesion,{
      decision:"manual_review",memberCount:vectors.length,minimumRebuildMembers:this.thresholds.minimumRebuildMembers,
      minimumCohesion:this.thresholds.minimumCohesion,dispersion:1-cohesion,modelVersion:cluster.embeddingModelVersion,
    });
    return 1;
  }
}
