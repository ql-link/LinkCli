import { createHash } from "node:crypto";
import type { AnalysisCall } from "./types.js";

const identifierLike = /\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{4,}|[a-z]+[-_]\d+)\b/giu;

/**
 * 无损规范化：只做 Unicode 规范化、大小写统一和空白折叠，不删除或替换任何词——
 * 包括动作词、填充词。这些词是语义模型判断意图所需的信息，动作词只在 sceneOf 里被
 * 识别为场景标签，不在这里被抹除（MCPSTAT-1-L3 §6.3“规范化边界”）。
 */
export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").toLocaleLowerCase().replace(/\s+/gu, " ").trim();
}

/**
 * 指纹专用文本：在规范化基础上额外去掉明显的参数型标识符和标点，用于识别“完全相同或仅参数不同”的
 * Query（§6.3 第一步）。这份更激进的清洗只喂给指纹哈希，不用于喂给语义模型的比较文本。
 */
function fingerprintText(query: string): string {
  return normalizeQuery(query).replace(identifierLike, " ").replace(/[\p{P}\p{S}\s]+/gu, "").trim();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function queryFingerprint(query: string): string {
  return sha256(fingerprintText(query));
}

export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0; let normA = 0; let normB = 0;
  for (let i = 0; i < a.length; i += 1) { const x = a[i] ?? 0; const y = b[i] ?? 0; dot += x * y; normA += x * x; normB += y * y; }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

export function averageVector(vectors: readonly (readonly number[])[]): number[] {
  if (vectors.length === 0) return [];
  const dim = vectors[0]?.length ?? 0;
  const sum = new Array<number>(dim).fill(0);
  for (const vector of vectors) for (let i = 0; i < dim; i += 1) sum[i] = (sum[i] ?? 0) + (vector[i] ?? 0);
  return sum.map((value) => value / vectors.length);
}

export function modulePathOf(calls: AnalysisCall[]): { projectScope: string | null; modulePath: string[] | null; modulePathHash: string | null } {
  if (calls.length === 0 || calls.some((call) => !call.moduleId)) return { projectScope: null, modulePath: null, modulePathHash: null };
  const sorted = [...calls].sort((a, b) => a.sequence - b.sequence);
  const projects = [...new Set(sorted.map((call) => call.projectId))];
  const path: string[] = [];
  const qualifiedPath: Array<[string, string]> = [];
  for (const call of sorted) {
    const previous = qualifiedPath.at(-1);
    if (previous?.[0] === call.projectId && previous[1] === call.moduleId) continue;
    qualifiedPath.push([call.projectId, call.moduleId!]);
    path.push(call.moduleId!);
  }
  const scope = projects.join("→");
  return { projectScope: scope, modulePath: path, modulePathHash: sha256(JSON.stringify(qualifiedPath)) };
}

export function sceneOf(calls: AnalysisCall[]): { key: string; type: string; risk: "low" | "medium" | "high"; toolPath: Array<{ projectId: string; moduleId: string | null; toolName: string; operation: string | null }> } | null {
  if (calls.length === 0) return null;
  const sorted = [...calls].sort((a, b) => a.sequence - b.sequence);
  const toolPath = sorted.map((call) => ({ projectId: call.projectId, moduleId: call.moduleId ?? null, toolName: call.toolName, operation: call.operation ?? null }));
  const type = sorted.map((call) => call.operation?.trim() || call.toolName).join(" → ");
  const high = sorted.some((call) => /delete|remove|删除|移除/i.test(call.operation ?? call.toolName));
  const medium = sorted.some((call) => /update|edit|change|create|修改|更新|编辑|新增|创建/i.test(call.operation ?? call.toolName));
  const signature = sorted.map((call) => `${call.projectId}/${call.moduleId ?? "?"}/${call.toolName}/${[...call.parameterKeys].sort().join(",")}`).join("→");
  return { key: sha256(signature), type, risk: high ? "high" : medium ? "medium" : "low", toolPath };
}
