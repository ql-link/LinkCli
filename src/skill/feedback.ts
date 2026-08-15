import { randomUUID } from "node:crypto";
import type { Pool } from "mysql2/promise";
import type { SkillRepository, SkillValidationRun } from "./types.js";

export interface SkillFeedbackSink { publish(run: SkillValidationRun): Promise<void>; }
export class NoopSkillFeedbackSink implements SkillFeedbackSink { async publish(): Promise<void> {} }
export class MySqlSkillFeedbackSink implements SkillFeedbackSink {
  constructor(private readonly pool: Pool, private readonly repository: SkillRepository) {}
  async publish(run: SkillValidationRun): Promise<void> {
    const skill = await this.repository.getSkill(run.skillId);
    if (!skill) return;
    await this.pool.execute("INSERT IGNORE INTO mcp_l4_validation_feedback (feedback_id,cluster_id,cluster_version,skill_id,skill_version,verdict,replay_summary,database_check_summary) VALUES (?,?,?,?,?,?,?,?)", [randomUUID(), skill.sourceClusterId, skill.sourceClusterVersion, skill.id, run.skillVersionId, run.verdict, JSON.stringify(run.replaySummary), JSON.stringify(run.databaseCheckSummary)]);
  }
}
