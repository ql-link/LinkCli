import { averageVector, cosineSimilarity } from "./similarity.js";
import type { AnalysisRepository } from "./repository.js";
import type { ClusterThresholds, QueryCluster } from "./types.js";

export interface RebuildResult { buckets: number; merged: number; }

function bucketKeyOf(cluster: QueryCluster): string {
  return `${cluster.clusterType}\0${cluster.projectScope ?? ""}\0${cluster.modulePathHash ?? ""}\0${cluster.embeddingModelVersion ?? ""}`;
}

/**
 * 周期性对每个候选范围内“观察中”的类别做批内合并检查，修正在线单点匹配的顺序敏感问题
 * （MCPSTAT-1-L3 §6.3“周期性合并与拆分”）。当前版本只做合并：质心距离足够近的类别视为
 * 同一业务需求的不同增量分支，迁移全部成员到样本更多的一方，旧类别标记为“已合并”。
 * 拆分（类别内部方差过高）仅记录评分历史供人工复核，不在本版本自动执行。
 */
export class ClusterRebuildJob {
  constructor(private readonly repository: AnalysisRepository, private readonly thresholds: ClusterThresholds) {}

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
      let merged = 0;
      for (const group of buckets.values()) {
        if (group.length < 2) continue;
        merged += await this.consolidateBucket(repository, group);
      }
      return { buckets: buckets.size, merged };
    });
    return result ?? { buckets: 0, merged: 0 };
  }

  private async consolidateBucket(repository: AnalysisRepository, initial: QueryCluster[]): Promise<number> {
    let active = [...initial];
    let merged = 0;
    for (;;) {
      let bestSimilarity = -1;
      let bestPair: [QueryCluster, QueryCluster] | null = null;
      for (let i = 0; i < active.length; i += 1) {
        for (let j = i + 1; j < active.length; j += 1) {
          const left = active[i]!; const right = active[j]!;
          const similarity = cosineSimilarity(left.centroidVector!, right.centroidVector!);
          if (similarity > bestSimilarity) { bestSimilarity = similarity; bestPair = [left, right]; }
        }
      }
      if (!bestPair || bestSimilarity < this.thresholds.mergeSimilarity) break;
      const [a, b] = bestPair;
      const target = a.sampleCount >= b.sampleCount ? a : b;
      const source = target === a ? b : a;
      await repository.mergeClusters(target.id, source.id);
      await repository.appendScore(target.id, target.version, "cluster_merge", bestSimilarity, { mergedClusterId: source.id, mergedClusterKey: source.clusterKey, triggerSimilarity: bestSimilarity });
      merged += 1;
      const vectors = await repository.listMemberVectors(target.id);
      if (vectors.length && target.embeddingModelVersion) await repository.updateCentroid(target.id, averageVector(vectors), target.embeddingModelVersion);
      const recalculated = await repository.recalculateCluster(target.id);
      active = active.filter((cluster) => cluster.id !== source.id && cluster.id !== target.id);
      active.push({ ...recalculated, centroidVector: vectors.length ? averageVector(vectors) : target.centroidVector, embeddingModelVersion: target.embeddingModelVersion });
    }
    return merged;
  }
}
