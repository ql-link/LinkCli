import { createHash } from "node:crypto";
import type { JsonObject } from "../domain.js";
import type { SkillCandidate, SkillDefinition, SkillStep, SkillToolDependency } from "./types.js";

export interface SkillGeneratorResult { definition: SkillDefinition; model: string; }
export interface SkillGenerator { generate(candidate: SkillCandidate): Promise<SkillGeneratorResult>; }

function asObject(value: unknown): JsonObject | null { return value && typeof value === "object" && !Array.isArray(value) ? value as JsonObject : null; }
function asString(value: unknown): string | null { return typeof value === "string" && value.trim() ? value.trim() : null; }

/**
 * 默认生成器不连接外部 AI，只把 L3 已脱敏的候选证据转换成可校验草稿。
 * 真实模型接入必须替换同一接口，并保留结构校验和人工审核门禁。
 */
export class DeterministicSkillGenerator implements SkillGenerator {
  async generate(candidate: SkillCandidate): Promise<SkillGeneratorResult> {
    const payload = candidate.payload;
    const representativeQuery = asString(payload.representativeQuery) ?? `cluster-${candidate.clusterId}`;
    const path = Array.isArray(payload.toolPath) ? payload.toolPath : [];
    const steps: SkillStep[] = path.flatMap((item, index) => {
      const value = asObject(item);
      const projectId = asString(value?.projectId);
      const originalName = asString(value?.toolName);
      if (!projectId || !originalName) return [];
      const dependency: SkillToolDependency = { projectId, serviceVersionId: asString(value?.serviceVersionId), toolVersionId: asString(value?.toolVersionId), originalName };
      return [{ id: `step-${index + 1}`, tool: dependency, inputMapping: { query: "$.query" }, outputKey: `step_${index + 1}` }];
    });
    const queries = Array.isArray(payload.representativeQueries) ? payload.representativeQueries.filter((item): item is string => typeof item === "string" && item.trim().length > 0) : [];
    const sampleQueries = [...new Set([representativeQuery, ...queries])].slice(0, 10);
    const definition: SkillDefinition = {
      name: `l4_skill_${candidate.clusterId}`,
      description: `由 Query 类别 ${candidate.clusterId} 生成的 Skill 草稿：${representativeQuery}`,
      inputSchema: { type: "object", properties: { query: { type: "string", minLength: 1 } }, required: ["query"] },
      outputSchema: { type: "object", properties: { result: {} } },
      steps,
      validationCases: sampleQueries.map((query, index) => ({ id: `sample-${index + 1}`, query, input: { query }, expected: null })),
    };
    return { definition, model: "deterministic-l4-v1" };
  }
}

export function sampleSetHash(definition: SkillDefinition): string {
  return createHash("sha256").update(JSON.stringify(definition.validationCases)).digest("hex");
}
