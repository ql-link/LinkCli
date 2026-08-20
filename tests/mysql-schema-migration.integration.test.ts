import { execFile } from "node:child_process";
import { promisify } from "node:util";
import mysql, { type Pool } from "mysql2/promise";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const databaseUrl = process.env.LINKCLI_TEST_MYSQL_URL;
const databaseName = databaseUrl ? decodeURIComponent(new URL(databaseUrl).pathname.split("/").pop() ?? "") : "";
const realMySqlDescribe = databaseUrl && databaseName.endsWith("_test") ? describe : describe.skip;
const run = promisify(execFile);

realMySqlDescribe("real MySQL 17-to-14 table migration", () => {
  let pool: Pool;
  beforeAll(async () => {
    pool = mysql.createPool({ uri: databaseUrl!, connectionLimit: 2, timezone: "Z" });
    const [[row]] = await pool.query<mysql.RowDataPacket[]>("SELECT DATABASE() name");
    if (!String(row?.name ?? "").endsWith("_test")) throw new Error("Refusing destructive schema migration test outside an _test database");
  });
  afterAll(async () => { await pool?.end(); });

  it("keeps the legacy feedback table until every semantic field matches", async () => {
    const suffix = `${Date.now()}`;
    const clusterKey = `migration-${suffix}`;
    const eventId = `migration-event-${suffix}`;
    const skillId = `00000000-0000-4000-8000-${suffix.slice(-12).padStart(12, "0")}`;
    const versionId = `10000000-0000-4000-8000-${suffix.slice(-12).padStart(12, "0")}`;
    const runId = `20000000-0000-4000-8000-${suffix.slice(-12).padStart(12, "0")}`;
    await pool.query("DROP TABLE IF EXISTS mcp_l4_validation_feedback");
    await pool.query("CREATE TABLE mcp_l4_validation_feedback (id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,feedback_id VARCHAR(64) NOT NULL,cluster_id BIGINT UNSIGNED NOT NULL,cluster_version BIGINT UNSIGNED NOT NULL,skill_id VARCHAR(191) NULL,skill_version VARCHAR(64) NULL,verdict VARCHAR(24) NOT NULL,replay_summary JSON NULL,database_check_summary JSON NULL,created_at DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6)) ENGINE=InnoDB");
    await pool.execute("INSERT INTO mcp_analysis_input (event_id,turn_id,settlement_version,actor_hash,query_text,query_fingerprint,calls,settlement_status,collection_trust,occurred_at) VALUES (?,?,1,?, ?,?,JSON_ARRAY(),'success','trusted',UTC_TIMESTAMP(6))", [eventId, `turn-${suffix}`, "a".repeat(64), "迁移测试", "b".repeat(64)]);
    const [cluster] = await pool.execute<mysql.ResultSetHeader>("INSERT INTO mcp_query_cluster (cluster_key,cluster_type,project_scope,module_path_hash,module_path,representative_event_id,status,sample_count,distinct_actor_count,success_count,coverage_gap_count,attempted_skill_count,semantic_cohesion,input_completeness,first_seen_at,last_seen_at,version) VALUES (?,'normal',NULL,NULL,NULL,?,'observing',0,0,0,0,0,0,0,UTC_TIMESTAMP(6),UTC_TIMESTAMP(6),1)", [clusterKey, eventId]);
    const clusterId = cluster.insertId;
    await pool.execute("INSERT INTO mcp_skills (id,skill_key,source_cluster_id,source_cluster_version,candidate_type,status,current_version_id,revision) VALUES (?,?,?,1,'new_skill','draft',NULL,0)", [skillId, `skill-${suffix}`, clusterId]);
    await pool.execute("INSERT INTO mcp_skill_versions (id,skill_id,version_no,definition,dependency_snapshot,generator_model,source_event_id) VALUES (?,?,1,JSON_OBJECT('name','迁移测试','validationCases',JSON_ARRAY(),'steps',JSON_ARRAY()),JSON_ARRAY(),'test',?)", [versionId, skillId, `source-${suffix}`]);
    await pool.execute("UPDATE mcp_skills SET current_version_id=? WHERE id=?", [versionId, skillId]);
    await pool.execute("INSERT INTO mcp_skill_validation_runs (id,skill_id,skill_version_id,trigger_type,sample_set_hash,verdict,replay_summary,database_check_summary) VALUES (?,?,?,'manual',?,'passed',JSON_OBJECT('same',TRUE),JSON_OBJECT('rows',1))", [runId, skillId, versionId, "c".repeat(64)]);
    await pool.execute("INSERT INTO mcp_l4_validation_feedback (feedback_id,cluster_id,cluster_version,skill_id,skill_version,verdict,replay_summary,database_check_summary) VALUES (?,?,1,?,?,'passed',JSON_OBJECT('same',FALSE),JSON_OBJECT('rows',1))", [`feedback-${suffix}`, clusterId, skillId, versionId]);

    await expect(run(process.execPath, ["scripts/db/apply-analysis-schema.mjs"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl! } })).rejects.toThrow(/not exact validation run copies/);
    const [[kept]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='mcp_l4_validation_feedback'");
    expect(Number(kept?.count)).toBe(1);

    await pool.query("UPDATE mcp_l4_validation_feedback SET replay_summary=JSON_OBJECT('same',TRUE)");
    await run(process.execPath, ["scripts/db/apply-analysis-schema.mjs"], { cwd: process.cwd(), env: { ...process.env, DATABASE_URL: databaseUrl! } });
    const [[dropped]] = await pool.query<mysql.RowDataPacket[]>("SELECT COUNT(*) count FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name='mcp_l4_validation_feedback'");
    expect(Number(dropped?.count)).toBe(0);

    await pool.execute("DELETE FROM mcp_skill_validation_runs WHERE id=?", [runId]);
    await pool.execute("UPDATE mcp_skills SET current_version_id=NULL WHERE id=?", [skillId]);
    await pool.execute("DELETE FROM mcp_skill_versions WHERE id=?", [versionId]);
    await pool.execute("DELETE FROM mcp_skills WHERE id=?", [skillId]);
    await pool.execute("DELETE FROM mcp_query_cluster WHERE id=?", [clusterId]);
    await pool.execute("DELETE FROM mcp_analysis_input WHERE event_id=?", [eventId]);
  }, 60_000);
});
