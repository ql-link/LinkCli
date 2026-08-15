import { describe, expect, it } from "vitest";
import { MemoryAnalysisRepository } from "../src/analysis/repository.js";
import { SkillCandidateWorker } from "../src/skill/candidate-worker.js";
import { MemorySkillRepository } from "../src/skill/repository.js";
import { SkillService } from "../src/skill/service.js";

describe("SkillCandidateWorker", () => {
  it("claims, generates and marks an L3 candidate delivered", async () => {
    const source = new MemoryAnalysisRepository();
    const cluster = await source.createCluster({ clusterKey: "k", clusterType: "normal", projectScope: null, modulePathHash: "m", modulePath: ["m"], representativeEventId: "e", representativeQuery: "查数据", status: "observing", mergedIntoClusterId: null, sampleCount: 1, distinctActorCount: 1, successCount: 1, coverageGapCount: 0, attemptedSkillCount: 0, semanticCohesion: 1, inputCompleteness: 1, centroidVector: [1], embeddingModelVersion: "test", firstSeenAt: new Date(), lastSeenAt: new Date(), version: 1 });
    await source.handOffCandidate(cluster.id, { eventId: "candidate-1", clusterId: cluster.id, clusterVersion: 1, candidateType: "new_skill", payload: { representativeQuery: "查数据" } });
    const skills = new SkillService(new MemorySkillRepository());
    const worker = new SkillCandidateWorker(source, skills, { batchSize: 10, leaseMs: 1000, maxAttempts: 3, retryBaseMs: 1 });
    const result = await worker.drainOnce(new Date());
    expect(result).toMatchObject({ claimed: 1, delivered: 1, failed: 0 });
    expect((await skills.list())).toHaveLength(1);
    expect((await worker.drainOnce(new Date(Date.now() + 2000))).claimed).toBe(0);
  });
});
