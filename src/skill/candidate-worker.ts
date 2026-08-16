import type { AnalysisRepository } from "../analysis/repository.js";
import type { CandidateEvent } from "../analysis/types.js";
import type { SkillService } from "./service.js";

export interface SkillCandidateWorkerSettings { batchSize: number; leaseMs: number; maxAttempts: number; retryBaseMs: number; }
export interface SkillCandidateDrainResult { claimed: number; delivered: number; failed: number; dead: number; }

export class SkillCandidateWorker {
  constructor(private readonly source: AnalysisRepository, private readonly skills: SkillService, private readonly settings: SkillCandidateWorkerSettings) {}
  async drainOnce(now = new Date()): Promise<SkillCandidateDrainResult> {
    const workerId = `l4-candidate-${process.pid}`;
    const events = await this.source.claimCandidateEvents(workerId, now, this.settings.leaseMs, this.settings.batchSize);
    const result: SkillCandidateDrainResult = { claimed: events.length, delivered: 0, failed: 0, dead: 0 };
    for (const event of events) {
      try {
        const skill = await this.skills.receiveCandidate(event as CandidateEvent);
        await this.skills.enqueueValidation(skill.id, "generation", now);
        if (await this.source.markCandidateDelivered(event.eventId, workerId, now)) result.delivered++;
      } catch {
        const next = new Date(now.getTime() + this.settings.retryBaseMs);
        await this.source.markCandidateFailure(event.eventId, workerId, next, this.settings.maxAttempts);
        result.failed++;
      }
    }
    return result;
  }
}
