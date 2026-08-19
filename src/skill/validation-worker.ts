import type { SkillRepository } from "./types.js";
import type { SkillService } from "./service.js";
import { NoopSkillFeedbackSink, type SkillFeedbackSink } from "./feedback.js";

export interface SkillValidationWorkerSettings { batchSize: number; leaseMs: number; maxAttempts: number; retryBaseMs: number; }
export class SkillValidationWorker {
  constructor(private readonly repository: SkillRepository, private readonly service: SkillService, private readonly settings: SkillValidationWorkerSettings, private readonly feedback: SkillFeedbackSink = new NoopSkillFeedbackSink()) {}
  async drainOnce(now = new Date()): Promise<{ claimed: number; completed: number; failed: number }> {
    const workerId = `l4-validation-${process.pid}`;
    const jobs = await this.repository.claimValidationJobs(workerId, now, this.settings.leaseMs, this.settings.batchSize);
    let completed = 0; let failed = 0;
    for (const job of jobs) {
      try { const run = await this.service.validate(job.skillId, job.trigger, now); await this.feedback.publish(run); if (await this.repository.completeValidationJob(job.id, workerId, now)) completed++; }
      catch (error) { await this.repository.failValidationJob(job.id, workerId, new Date(now.getTime() + this.settings.retryBaseMs), this.settings.maxAttempts, error instanceof Error ? "L4_VALIDATION_FAILED" : "L4_VALIDATION_ERROR"); failed++; }
    }
    return { claimed: jobs.length, completed, failed };
  }
}
