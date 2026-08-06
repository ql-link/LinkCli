import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const databaseUrl=process.env.DATABASE_URL;
if(!databaseUrl)throw new Error("DATABASE_URL is required");
const schemaPath=fileURLToPath(new URL("../../src/db/schema.sql",import.meta.url));
const schema=await readFile(schemaPath,"utf8");
const marker="CREATE TABLE platform_users";const start=schema.indexOf(marker);
if(start<0)throw new Error("Console schema marker not found");
const sql=schema.slice(start).replaceAll("CREATE TABLE platform_","CREATE TABLE IF NOT EXISTS platform_");
const connection=await mysql.createConnection({uri:databaseUrl,multipleStatements:true,timezone:"Z"});
try{await connection.query(sql);process.stdout.write("LinkCli console schema is ready\n");}finally{await connection.end();}
