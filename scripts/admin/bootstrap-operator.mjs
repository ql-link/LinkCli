import { createInterface } from "node:readline/promises";
import { randomUUID } from "node:crypto";
import process from "node:process";
import argon2 from "argon2";
import mysql from "mysql2/promise";

const value = (name) => { const index=process.argv.indexOf(name); return index>=0?process.argv[index+1]:undefined; };
const username=value("--username"); const displayName=value("--display-name")??username;
if(!username||!displayName) throw new Error("Usage: npm run admin:bootstrap -- --username <name> [--display-name <name>]");
if(!process.env.DATABASE_URL) throw new Error("DATABASE_URL is required");
const terminal=createInterface({input:process.stdin,output:process.stdout});
const password=await terminal.question("Operator password (12-128 characters): "); terminal.close();
if(password.length<12||password.length>128) throw new Error("Password must be 12-128 characters");
const hash=await argon2.hash(password,{type:argon2.argon2id,memoryCost:19456,timeCost:2,parallelism:1});
const connection=await mysql.createConnection({uri:process.env.DATABASE_URL,timezone:"Z"});
try {
  const [existing]=await connection.query("SELECT id,role FROM platform_users WHERE username=?",[username]);
  if(existing[0]) { await connection.execute("UPDATE platform_users SET role='operator',display_name=? WHERE id=?",[displayName,existing[0].id]); process.stdout.write(`Operator ready: ${username}\n`); }
  else { await connection.execute("INSERT INTO platform_users (id,username,display_name,password_hash,role) VALUES (?,?,?,?, 'operator')",[randomUUID(),username,displayName,hash]); process.stdout.write(`Operator created: ${username}\n`); }
} finally { await connection.end(); }
