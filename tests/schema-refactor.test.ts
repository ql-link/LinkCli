import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const schemaUrl = new URL("../src/db/schema.sql", import.meta.url);
const upgradeUrl = new URL("../scripts/db/apply-analysis-schema.mjs", import.meta.url);

describe("L2-L4 physical data model", () => {
  it("keeps fourteen responsibility-bearing tables and removes one-to-one duplicates", async () => {
    const schema = await readFile(schemaUrl, "utf8");
    const l2ToL4Tables = [
      "mcp_call_outbox",
      "mcp_turns",
      "mcp_call_events",
      "mcp_analysis_outbox",
      "mcp_analysis_input",
      "mcp_query_cluster",
      "mcp_query_cluster_scene",
      "mcp_cluster_score_history",
      "mcp_l4_candidate_outbox",
      "mcp_skills",
      "mcp_skill_versions",
      "mcp_skill_validation_runs",
      "mcp_skill_reviews",
      "mcp_skill_validation_jobs",
    ];

    for (const table of l2ToL4Tables) expect(schema).toContain(`CREATE TABLE ${table} (`);
    expect(schema).not.toContain("CREATE TABLE mcp_query_cluster_member (");
    expect(schema).not.toContain("CREATE TABLE mcp_skill_coverage_gap (");
    expect(schema).not.toContain("CREATE TABLE mcp_l4_validation_feedback (");
    expect(schema).toContain("cluster_id BIGINT UNSIGNED NULL COMMENT 'L3 归属的唯一 Query 类别；未分析时为空'");
    expect(schema).toContain("coverage_gap_type VARCHAR(32) NULL");
  });

  it("creates both analysis and collection tables from the additive upgrade entrypoint", async () => {
    const upgrade = await readFile(upgradeUrl, "utf8");
    expect(upgrade).toContain('const collectionMarker="CREATE TABLE mcp_call_outbox"');
    expect(upgrade).toContain("const collectionSql=schema.slice(collectionStart)");
    expect(upgrade).toContain("const sql=`${analysisSql}\\n${collectionSql}`");
    expect(upgrade).toContain("rows are not exact validation run copies");
    expect(upgrade).toContain("JSON_CONTAINS(f.replay_summary,r.replay_summary)");
    expect(upgrade).toContain("s.source_cluster_version=f.cluster_version");
    expect(upgrade).toContain("idx_mcp_skill_validation_jobs_version");
    expect(upgrade.indexOf("idx_mcp_skill_validation_jobs_version")).toBeLessThan(upgrade.indexOf('dropIndex("mcp_skill_validation_jobs","uk_mcp_skill_validation_jobs_version_trigger")'));
  });
});
