import { mkdir, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { generateL4E2EData } from "../../tests/fixtures/l4-e2e-data.js";

const output = resolve(process.argv[2] ?? "artifacts/l4-e2e-data.json");
const rows = generateL4E2EData({
  projectId: "fixture-project",
  moduleId: "orders",
  toolName: "echo",
  serviceVersionId: "fixture-service-version",
  toolVersionId: "fixture-tool-version",
});
await mkdir(dirname(output), { recursive: true });
await writeFile(output, `${JSON.stringify(rows, null, 2)}\n`, "utf8");
console.log(JSON.stringify({ output, rows: rows.length, actors: new Set(rows.map((row) => row.actorHash)).size, first: rows[0]?.occurredAt, last: rows.at(-1)?.occurredAt }, null, 2));
