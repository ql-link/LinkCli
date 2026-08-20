import { describe, expect, it } from "vitest";
import { MySqlSkillRepository } from "../src/skill/repository.js";
import type { SkillDbExecutor, SkillValidationJob } from "../src/skill/types.js";

const job: SkillValidationJob = {
  id: "00000000-0000-4000-8000-000000000001",
  skillId: "00000000-0000-4000-8000-000000000002",
  skillVersionId: "00000000-0000-4000-8000-000000000003",
  trigger: "manual",
  status: "pending",
  attempts: 0,
  nextAttemptAt: new Date("2026-08-20T00:00:00Z"),
  leaseOwner: null,
  leaseUntil: null,
  lastError: null,
  createdAt: new Date("2026-08-20T00:00:00Z"),
  updatedAt: new Date("2026-08-20T00:00:00Z"),
};

describe("MySqlSkillRepository validation enqueue", () => {
  it("treats only a duplicate key as an idempotent enqueue", async () => {
    const error = Object.assign(new Error("duplicate"), { code: "ER_DUP_ENTRY" });
    const repository = new MySqlSkillRepository({ async execute() { throw error; } } as unknown as SkillDbExecutor);
    await expect(repository.enqueueValidation(job)).resolves.toBe(false);
  });

  it("does not hide foreign-key or other persistence failures", async () => {
    const error = Object.assign(new Error("missing Skill version"), { code: "ER_NO_REFERENCED_ROW_2" });
    const repository = new MySqlSkillRepository({ async execute() { throw error; } } as unknown as SkillDbExecutor);
    await expect(repository.enqueueValidation(job)).rejects.toBe(error);
  });
});
