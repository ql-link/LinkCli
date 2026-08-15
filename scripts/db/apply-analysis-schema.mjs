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
const currentVersionConstraint="ALTER TABLE mcp_skills ADD CONSTRAINT fk_mcp_skills_current_version FOREIGN KEY (current_version_id) REFERENCES mcp_skill_versions (id) ON UPDATE RESTRICT ON DELETE RESTRICT;";
const sql=schema.slice(start,end).replaceAll("CREATE TABLE mcp_","CREATE TABLE IF NOT EXISTS mcp_").replace(currentVersionConstraint,"");
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
async function ensureColumn(table,column,definition){
  if(await tableExists(table)&&!await columnExists(table,column))await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}
async function ensureIndex(table,index,definition){
  if(await tableExists(table)&&!await indexExists(table,index))await connection.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
}
async function ensureForeignKey(table,constraint,definition){
  if(await tableExists(table)&&!await foreignKeyExists(table,constraint))await connection.query(`ALTER TABLE \`${table}\` ADD CONSTRAINT \`${constraint}\` ${definition}`);
}

try{
  await connection.query(sql);
  // CREATE TABLE IF NOT EXISTS 不会补齐存量表列；以下升级保持重复执行安全。
  await ensureColumn("mcp_tool_versions","module_key","module_key VARCHAR(64) CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_bin NULL COMMENT '登记时由项目负责人指定的业务模块标识，供 L3 聚类使用，不由系统猜测' AFTER original_name");
  await ensureIndex("mcp_tool_versions","idx_mcp_tool_versions_module","KEY idx_mcp_tool_versions_module (service_version_id, module_key)");
  await ensureColumn("mcp_query_cluster","centroid_vector","centroid_vector JSON NULL COMMENT '类别语义中心，成员向量算术平均，随成员增减增量更新' AFTER input_completeness");
  await ensureColumn("mcp_query_cluster","embedding_model_version","embedding_model_version VARCHAR(96) NULL COMMENT '<provider>:<model_name>:<dim>，模型切换后据此分批重算' AFTER centroid_vector");
  await ensureIndex("mcp_query_cluster","idx_mcp_query_cluster_model_version","KEY idx_mcp_query_cluster_model_version (embedding_model_version)");
  await ensureColumn("mcp_query_cluster_member","query_vector","query_vector JSON NULL COMMENT '该成员的 Query 向量，供质心增量重算和 ClusterRebuildJob 使用' AFTER semantic_similarity");
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
  process.stdout.write("LinkCli L3 analysis schema is ready\n");
}finally{await connection.end();}
