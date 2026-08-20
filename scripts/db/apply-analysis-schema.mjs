import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("DATABASE_URL is required");
const schemaPath=fileURLToPath(new URL("../../src/db/schema.sql",import.meta.url));
const schema=await readFile(schemaPath,"utf8");
const marker="CREATE TABLE mcp_analysis_input";const start=schema.indexOf(marker);
if(start<0)throw new Error("L3 analysis schema marker not found");
const endMarker="-- L3 ANALYSIS SCHEMA END";const end=schema.indexOf(endMarker,start);
if(end<0)throw new Error("L3 analysis schema end marker not found");
const collectionMarker="CREATE TABLE mcp_call_outbox";const collectionStart=schema.indexOf(collectionMarker,end);
if(collectionStart<0)throw new Error("L2 collection schema marker not found");
const currentVersionConstraint="ALTER TABLE mcp_skills ADD CONSTRAINT fk_mcp_skills_current_version FOREIGN KEY (current_version_id) REFERENCES mcp_skill_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT;";
const analysisClusterConstraint="ALTER TABLE mcp_analysis_input\n  ADD CONSTRAINT fk_mcp_analysis_input_cluster FOREIGN KEY (cluster_id) REFERENCES mcp_query_cluster (id) ON UPDATE RESTRICT ON DELETE RESTRICT;";
const analysisSql=schema.slice(start,end).replaceAll("CREATE TABLE mcp_","CREATE TABLE IF NOT EXISTS mcp_").replace(currentVersionConstraint,"").replace(analysisClusterConstraint,"");
const collectionSql=schema.slice(collectionStart).replaceAll("CREATE TABLE mcp_","CREATE TABLE IF NOT EXISTS mcp_");
const sql=`${analysisSql}\n${collectionSql}`;
const connection=await mysql.createConnection({uri:databaseUrl,multipleStatements:true,timezone:"Z"});
async function tableExists(table){
  const [rows]=await connection.query("SELECT 1 FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name=? LIMIT 1",[table]);
  return rows.length>0;
}
async function columnExists(table,column){
  const [rows]=await connection.query("SELECT 1 FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name=? AND column_name=? LIMIT 1",[table,column]);
  return rows.length>0;
}
async function indexExists(table,index){
  const [rows]=await connection.query("SELECT 1 FROM information_schema.statistics WHERE table_schema=DATABASE() AND table_name=? AND index_name=? LIMIT 1",[table,index]);
  return rows.length>0;
}
async function foreignKeyExists(table,constraint){
  const [rows]=await connection.query("SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=? AND constraint_type='FOREIGN KEY' LIMIT 1",[table,constraint]);
  return rows.length>0;
}
async function constraintExists(table,constraint){
  const [rows]=await connection.query("SELECT 1 FROM information_schema.table_constraints WHERE constraint_schema=DATABASE() AND table_name=? AND constraint_name=? LIMIT 1",[table,constraint]);
  return rows.length>0;
}
async function ensureColumn(table,column,definition){
  if(await tableExists(table)&&!await columnExists(table,column))await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}
async function ensureIndex(table,index,definition){
  if(await tableExists(table)&&!await indexExists(table,index))await connection.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
}
async function dropIndex(table,index){
  if(await tableExists(table)&&await indexExists(table,index))await connection.query(`ALTER TABLE \`${table}\` DROP INDEX \`${index}\``);
}
async function ensureForeignKey(table,constraint,definition){
  if(await tableExists(table)&&!await foreignKeyExists(table,constraint))await connection.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` ${definition}`);
}
async function ensureCheck(table,constraint,definition){
  if(await tableExists(table)&&!await constraintExists(table,constraint))await connection.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` CHECK (${definition})`);
}
async function scalar(sql,params=[]){
  const [rows]=await connection.query(sql,params); return Number(Object.values(rows[0]??{value:0})[0]??0);
}

try{
  await connection.query(sql);
  // CREATE TABLE IF NOT EXISTS 不会补齐存量表列；以下升级保持重复执行安全。
  await ensureColumn("mcp_tool_versions","module_key","module_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL COMMENT '登记时由项目负责人指定的业务模块标识，供 L3 聚类使用，不由系统猜测' AFTER original_name");
  await ensureIndex("mcp_tool_versions","idx_mcp_tool_versions_module","KEY idx_mcp_tool_versions_module (service_version_id, module_key)");
  await ensureColumn("mcp_query_cluster","centroid_vector","centroid_vector JSON NULL COMMENT '类别语义中心，成员向量算术平均，随成员增减增量更新' AFTER input_completeness");
  await ensureColumn("mcp_query_cluster","embedding_model_version","embedding_model_version VARCHAR(96) NULL COMMENT '<provider>:<model_name>:<dim>，模型切换后据此分批重算' AFTER centroid_vector");
  await ensureIndex("mcp_query_cluster","idx_mcp_query_cluster_model_version","KEY idx_mcp_query_cluster_model_version (embedding_model_version)");
  await ensureColumn("mcp_analysis_input","cluster_id","cluster_id BIGINT UNSIGNED NULL COMMENT 'L3 归属的唯一 Query 类别；未分析时为空' AFTER attempted_skill_version");
  await ensureColumn("mcp_analysis_input","semantic_similarity","semantic_similarity DECIMAL(6,5) NULL COMMENT '与类别语义中心的相似度' AFTER cluster_id");
  await ensureColumn("mcp_analysis_input","query_vector","query_vector JSON NULL COMMENT 'Query 向量，供质心增量重算和类别重建使用' AFTER semantic_similarity");
  await ensureColumn("mcp_analysis_input","scene_type","scene_type VARCHAR(512) NULL COMMENT '组内操作场景描述' AFTER query_vector");
  await ensureColumn("mcp_analysis_input","threshold_eligible","threshold_eligible BOOLEAN NULL COMMENT '是否计入候选门槛；未分析时为空' AFTER scene_type");
  await ensureColumn("mcp_analysis_input","quality_success","quality_success BOOLEAN NULL COMMENT '是否为无重试、切路、放弃或无产出的成功轮次；未分析时为空' AFTER threshold_eligible");
  await ensureColumn("mcp_analysis_input","exclusion_reason","exclusion_reason VARCHAR(64) NULL COMMENT '不计候选门槛的原因' AFTER quality_success");
  await ensureColumn("mcp_analysis_input","coverage_gap_type","coverage_gap_type VARCHAR(32) NULL COMMENT 'not_covered/partial_coverage/mismatch/execution_failure' AFTER exclusion_reason");
  await ensureColumn("mcp_analysis_input","coverage_gap_evidence","coverage_gap_evidence JSON NULL COMMENT '已有 Skill 覆盖过窄或误匹配的脱敏证据' AFTER coverage_gap_type");
  await ensureColumn("mcp_analysis_input","clustered_at","clustered_at DATETIME(6) NULL COMMENT 'UTC L3 完成归类时间' AFTER coverage_gap_evidence");
  await ensureIndex("mcp_analysis_input","idx_mcp_analysis_input_cluster","KEY idx_mcp_analysis_input_cluster (cluster_id, clustered_at, id)");
  await ensureCheck("mcp_analysis_input","ck_mcp_analysis_input_gap","coverage_gap_type IS NULL OR coverage_gap_type IN ('not_covered','partial_coverage','mismatch','execution_failure')");
  await ensureColumn("mcp_skill_validation_jobs","active_dedupe_key","active_dedupe_key VARCHAR(96) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL COMMENT '仅 pending/running 持有的版本与触发类型幂等键' AFTER trigger_type");
  if(await tableExists("mcp_skill_validation_jobs")){
    await connection.query("UPDATE mcp_skill_validation_jobs SET active_dedupe_key=CASE WHEN status IN ('pending','running') THEN CONCAT(skill_version_id,':',trigger_type) ELSE NULL END");
    await ensureIndex("mcp_skill_validation_jobs","idx_mcp_skill_validation_jobs_version","KEY idx_mcp_skill_validation_jobs_version (skill_version_id)");
    await dropIndex("mcp_skill_validation_jobs","uk_mcp_skill_validation_jobs_version_trigger");
    await ensureIndex("mcp_skill_validation_jobs","uk_mcp_skill_validation_jobs_active","UNIQUE KEY uk_mcp_skill_validation_jobs_active (active_dedupe_key)");
  }

  // 旧成员表是一对一扩展：唯一 analysis_input_id 证明这些字段属于分析输入本身。
  if(await tableExists("mcp_query_cluster_member")){
    await ensureColumn("mcp_query_cluster_member","query_vector","query_vector JSON NULL COMMENT '该成员的 Query 向量' AFTER semantic_similarity");
    await connection.query(`UPDATE mcp_analysis_input i JOIN mcp_query_cluster_member m ON m.analysis_input_id=i.id
      SET i.cluster_id=m.cluster_id,i.semantic_similarity=m.semantic_similarity,i.query_vector=m.query_vector,i.scene_type=m.scene_type,
          i.threshold_eligible=m.threshold_eligible,i.quality_success=m.quality_success,i.exclusion_reason=m.exclusion_reason,i.clustered_at=m.created_at
      WHERE i.cluster_id IS NULL`);
    const missing=await scalar("SELECT COUNT(*) value FROM mcp_query_cluster_member m LEFT JOIN mcp_analysis_input i ON i.id=m.analysis_input_id AND i.cluster_id=m.cluster_id WHERE i.id IS NULL");
    if(missing>0)throw new Error(`Refusing to drop mcp_query_cluster_member: ${missing} rows were not migrated`);
  }

  // L2 每轮只记录一个 attempted Skill；覆盖缺口因此也是分析输入的一对一扩展。
  if(await tableExists("mcp_skill_coverage_gap")){
    const duplicates=await scalar("SELECT COUNT(*) value FROM (SELECT analysis_input_id FROM mcp_skill_coverage_gap GROUP BY analysis_input_id HAVING COUNT(*)>1) duplicated");
    if(duplicates>0)throw new Error(`Refusing to merge mcp_skill_coverage_gap: ${duplicates} inputs have multiple gap rows`);
    await connection.query(`UPDATE mcp_analysis_input i JOIN mcp_skill_coverage_gap g ON g.analysis_input_id=i.id
      SET i.coverage_gap_type=g.gap_type,i.coverage_gap_evidence=g.evidence
      WHERE i.coverage_gap_type IS NULL AND i.cluster_id=g.cluster_id AND i.attempted_skill_id=g.attempted_skill_id`);
    const missing=await scalar("SELECT COUNT(*) value FROM mcp_skill_coverage_gap g LEFT JOIN mcp_analysis_input i ON i.id=g.analysis_input_id AND i.cluster_id=g.cluster_id AND i.attempted_skill_id=g.attempted_skill_id AND i.coverage_gap_type=g.gap_type WHERE i.id IS NULL");
    if(missing>0)throw new Error(`Refusing to drop mcp_skill_coverage_gap: ${missing} rows were not migrated`);
  }

  // 验证反馈只有在来源类别、结论和两份 JSON 证据均精确等价时才可视为 validation_runs 的副本。
  if(await tableExists("mcp_l4_validation_feedback")){
    const unmatched=await scalar(`SELECT COUNT(*) value FROM mcp_l4_validation_feedback f
      WHERE NOT EXISTS (
        SELECT 1 FROM mcp_skill_validation_runs r
        JOIN mcp_skills s ON s.id=r.skill_id
        WHERE r.skill_id=f.skill_id
          AND r.skill_version_id=f.skill_version
          AND r.verdict=f.verdict
          AND s.source_cluster_id=f.cluster_id
          AND s.source_cluster_version=f.cluster_version
          AND ((f.replay_summary IS NULL AND r.replay_summary IS NULL) OR (f.replay_summary IS NOT NULL AND r.replay_summary IS NOT NULL AND JSON_CONTAINS(f.replay_summary,r.replay_summary) AND JSON_CONTAINS(r.replay_summary,f.replay_summary)))
          AND ((f.database_check_summary IS NULL AND r.database_check_summary IS NULL) OR (f.database_check_summary IS NOT NULL AND r.database_check_summary IS NOT NULL AND JSON_CONTAINS(f.database_check_summary,r.database_check_summary) AND JSON_CONTAINS(r.database_check_summary,f.database_check_summary)))
      )`);
    if(unmatched>0)throw new Error(`Refusing to drop mcp_l4_validation_feedback: ${unmatched} rows are not exact validation run copies`);
  }

  await ensureForeignKey("mcp_analysis_input","fk_mcp_analysis_input_cluster","FOREIGN KEY (cluster_id) REFERENCES mcp_query_cluster (id) ON UPDATE RESTRICT ON DELETE RESTRICT");
  if(await tableExists("mcp_skill_coverage_gap"))await connection.query("DROP TABLE mcp_skill_coverage_gap");
  if(await tableExists("mcp_query_cluster_member"))await connection.query("DROP TABLE mcp_query_cluster_member");
  if(await tableExists("mcp_l4_validation_feedback"))await connection.query("DROP TABLE mcp_l4_validation_feedback");
  await ensureForeignKey("mcp_skills","fk_mcp_skills_current_version","FOREIGN KEY (current_version_id) REFERENCES mcp_skill_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT");
  await ensureColumn("mcp_skills","exposure_percent","exposure_percent TINYINT UNSIGNED NOT NULL DEFAULT 0 AFTER current_version_id");
  await ensureColumn("mcp_call_outbox","skill_id","skill_id CHAR(36) NULL COMMENT '所属 Skill 标识' AFTER tool_name");
  await ensureColumn("mcp_call_outbox","skill_version_id","skill_version_id CHAR(36) NULL COMMENT '所属 Skill 版本' AFTER skill_id");
  await ensureColumn("mcp_call_outbox","skill_run_id","skill_run_id CHAR(36) NULL COMMENT '一次 Skill 运行标识' AFTER skill_version_id");
  await ensureColumn("mcp_call_outbox","skill_step_id","skill_step_id VARCHAR(128) NULL COMMENT 'Skill 内部步骤标识' AFTER skill_run_id");
  await ensureColumn("mcp_call_events","skill_id","skill_id CHAR(36) NULL COMMENT '所属 Skill 标识' AFTER tool_name");
  await ensureColumn("mcp_call_events","skill_version_id","skill_version_id CHAR(36) NULL COMMENT '所属 Skill 版本' AFTER skill_id");
  await ensureColumn("mcp_call_events","skill_run_id","skill_run_id CHAR(36) NULL COMMENT '一次 Skill 运行标识' AFTER skill_version_id");
  await ensureColumn("mcp_call_events","skill_step_id","skill_step_id VARCHAR(128) NULL COMMENT 'Skill 内部步骤标识' AFTER skill_run_id");
  await ensureColumn("mcp_l4_candidate_outbox","lease_owner","lease_owner VARCHAR(128) NULL COMMENT 'L4 候选消费者租约持有者' AFTER attempt_count");
  await ensureColumn("mcp_l4_candidate_outbox","lease_until","lease_until DATETIME(6) NULL COMMENT 'L4 候选消费者租约截止时间' AFTER lease_owner");
  process.stdout.write("LinkCli L2-L4 analysis schema is ready (14-table model)\n");
}finally{await connection.end();}
