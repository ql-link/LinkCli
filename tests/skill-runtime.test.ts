import { describe, expect, it } from "vitest";
import { createHarness, registerSubmitted, approve } from "./fixtures/harness.js";
import { MemorySkillRepository } from "../src/skill/repository.js";
import { SkillService } from "../src/skill/service.js";
import { DeterministicSkillGenerator } from "../src/skill/generator.js";
import { SkillValidationRunner } from "../src/skill/validation.js";
import { SkillRuntime } from "../src/skill/runtime.js";
import { CatalogService } from "../src/gateway/catalog.js";
import { GatewayRouter } from "../src/gateway/router.js";
import type { AuthorityChecker, SkillCaseExecutor } from "../src/skill/types.js";

describe("SkillRuntime", () => {
  it("publishes an active Skill and executes immutable Tool steps without retries", async () => {
    const harness = createHarness();
    const registered = await registerSubmitted(harness);
    await approve(harness, registered.version.id);
    const tool = registered.tools[0]!;
    const executor: SkillCaseExecutor = { async execute() { return { verdict: "passed", replay: { ok: true }, databaseCheck: { ok: true } }; } };
    const authority: AuthorityChecker = { async check() { return { verdict: "passed", summary: { matched: true } }; } };
    const skills = new SkillService(new MemorySkillRepository(), new DeterministicSkillGenerator(), new SkillValidationRunner(executor, authority));
    const skill = await skills.receiveCandidate({ eventId: "candidate-1", clusterId: 1, clusterVersion: 1, candidateType: "new_skill", payload: { representativeQuery: "搜索知识", toolPath: [{ projectId: registered.project.id, serviceVersionId: registered.version.id, toolVersionId: tool.id, toolName: tool.originalName }] } });
    await skills.validate(skill.id, "generation");
    await skills.decideReview(skill.id, "approved", "reviewer-1");
    await skills.lifecycle(skill.id, "activate");
    const runtime = new SkillRuntime(skills, harness.repository, harness.connector, harness.cipher, harness.health, harness.collection, Buffer.alloc(32, 9), 1000);
    expect((await runtime.listTools()).map((item) => item.name)).toEqual(["skill__l4-1-new_skill"]);
    const result = await runtime.call("skill__l4-1-new_skill", { query: "搜索知识", __linkcli_user_question: "搜索知识" }, { platformOwnerId: "owner-1", credentialId: "credential-1", transportSessionId: "session-1", transportSessionSource: "custom" });
    expect(result.structuredContent).toMatchObject({ skillId: skill.id, skillVersionId: skill.currentVersionId });
    expect(harness.connector.endpoints.get("http://project.test/mcp")?.calls).toHaveLength(1);
    expect(harness.connector.endpoints.get("http://project.test/mcp")?.calls[0]?.arguments).toEqual({ query: "搜索知识" });
    expect((await harness.collection.listOutbox())).toHaveLength(1);
    const catalog = new CatalogService(harness.repository, 60_000, runtime);
    expect((await catalog.listTools()).some((item) => item.name === "skill__l4-1-new_skill")).toBe(true);
    const gateway = new GatewayRouter(harness.repository, catalog, harness.connector, harness.cipher, harness.health, harness.collection, Buffer.alloc(32, 9), 1000);
    await gateway.call("skill__l4-1-new_skill", { query: "搜索知识", __linkcli_user_question: "搜索知识" }, { platformOwnerId: "owner-1", credentialId: "credential-1", transportSessionId: "session-1", transportSessionSource: "custom" });
  });
});
