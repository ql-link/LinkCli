import { describe, expect, it } from "vitest";
import { MemorySkillRepository } from "../src/skill/repository.js";
import { DeterministicSkillGenerator } from "../src/skill/generator.js";
import { SkillService } from "../src/skill/service.js";
import { SkillValidationRunner } from "../src/skill/validation.js";
import type { AuthorityChecker, SkillCaseExecutor } from "../src/skill/types.js";

const candidate = { eventId: "event-1", clusterId: 7, clusterVersion: 2, candidateType: "new_skill" as const, payload: { representativeQuery: "查找合同", toolPath: [{ projectId: "project-1", serviceVersionId: "version-1", toolVersionId: "tool-1", toolName: "search" }] } };

describe("SkillService", () => {
  it("only generates once for the same L3 candidate and does not validate on receive", async () => {
    const repository = new MemorySkillRepository();
    const service = new SkillService(repository);
    const first = await service.receiveCandidate(candidate);
    const second = await service.receiveCandidate({ ...candidate, eventId: "event-2" });
    expect(first.id).toBe(second.id);
    expect((await service.get(first.id)).status).toBe("draft");
  });

  it("keeps a Skill blocked when no authoritative checker is configured", async () => {
    const service = new SkillService(new MemorySkillRepository());
    const skill = await service.receiveCandidate(candidate);
    const run = await service.validate(skill.id, "generation");
    expect(run.verdict).toBe("insufficient");
    expect((await service.get(skill.id)).status).toBe("validating");
  });

  it("requires review and canary before activation after a passed validation", async () => {
    const executor: SkillCaseExecutor = { async execute() { return { verdict: "passed", replay: { ok: true }, databaseCheck: { ok: true } }; } };
    const authority: AuthorityChecker = { async check() { return { verdict: "passed", summary: { matched: true } }; } };
    const service = new SkillService(new MemorySkillRepository(), new DeterministicSkillGenerator(), new SkillValidationRunner(executor, authority));
    const skill = await service.receiveCandidate(candidate);
    await service.validate(skill.id, "generation");
    expect((await service.get(skill.id)).status).toBe("pending_review");
    await service.decideReview(skill.id, "approved", "reviewer-1", "通过");
    expect((await service.get(skill.id)).status).toBe("canary");
    await service.lifecycle(skill.id, "activate");
    expect((await service.get(skill.id)).status).toBe("active");
  });

  it("does not allow ordinary lifecycle calls to bypass review", async () => {
    const service = new SkillService(new MemorySkillRepository());
    const skill = await service.receiveCandidate(candidate);
    await expect(service.lifecycle(skill.id, "activate")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });

  it("does not activate after a rejected review", async () => {
    const executor: SkillCaseExecutor = { async execute() { return { verdict: "passed", replay: {}, databaseCheck: {} }; } };
    const authority: AuthorityChecker = { async check() { return { verdict: "passed", summary: {} }; } };
    const service = new SkillService(new MemorySkillRepository(), new DeterministicSkillGenerator(), new SkillValidationRunner(executor, authority));
    const skill = await service.receiveCandidate(candidate);
    await service.validate(skill.id, "generation");
    await service.decideReview(skill.id, "rejected", "reviewer-1");
    expect((await service.get(skill.id)).status).toBe("degraded");
    await expect(service.lifecycle(skill.id, "activate")).rejects.toMatchObject({ code: "INVALID_STATE" });
  });
});
