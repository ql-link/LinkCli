import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import mysql from "mysql2/promise";

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required");
const schemaPath = fileURLToPath(new URL("../../src/db/schema.sql", import.meta.url));
const sql = await readFile(schemaPath, "utf8");
const connection = await mysql.createConnection({ uri: databaseUrl, multipleStatements: true, timezone: "Z" });
try {
  await connection.query(sql);
  process.stdout.write("LinkCli schema created successfully\n");
} finally {
  await connection.end();
}
