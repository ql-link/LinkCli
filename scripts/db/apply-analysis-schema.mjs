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
try{await connection.query(sql);process.stdout.write("LinkCli L3 analysis schema is ready\n");}finally{await connection.end();}
