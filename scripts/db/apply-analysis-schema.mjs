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
const sql=schema.slice(start,end).replaceAll("CREATE TABLE mcp_","CREATE TABLE IF NOT EXISTS mcp_");
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
async function ensureColumn(table,column,definition){
  if(await tableExists(table)&&!await columnExists(table,column))await connection.query(`ALTER TABLE \`${table}\` ADD COLUMN ${definition}`);
}
async function ensureIndex(table,index,definition){
  if(await tableExists(table)&&!await indexExists(table,index))await connection.query(`ALTER TABLE \`${table}\` ADD ${definition}`);
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
  process.stdout.write("LinkCli L3 analysis schema is ready\n");
}finally{await connection.end();}
