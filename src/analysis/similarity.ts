import { createHash } from "node:crypto";
import type { AnalysisCall } from "./types.js";

const actionWords = /(?:查询|查找|查阅|获取|读取|查看|检索|修改|更新|编辑|变更|删除|移除|取消|新增|创建|添加|新建|query|search|find|fetch|get|read|list|update|edit|change|delete|remove|cancel|create|add)/giu;
const fillerWords = /(?:请|帮我|一下|然后|之后|以后|并且|同时|需要|想要|the|a|an|please|then|and|after)/giu;
const identifierLike = /\b(?:[0-9a-f]{8}-[0-9a-f-]{27,}|\d{4,}|[a-z]+[-_]\d+)\b/giu;

export function normalizeQuery(query: string): string {
  return query.normalize("NFKC").toLocaleLowerCase().replace(identifierLike, " ").replace(actionWords, " ").replace(fillerWords, " ").replace(/[\p{P}\p{S}\s]+/gu, "").trim();
}

export function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function queryFingerprint(query: string): string {
  return sha256(normalizeQuery(query));
}

function features(value: string): Set<string> {
  const normalized = normalizeQuery(value);
  if (normalized.length < 2) return new Set(normalized ? [normalized] : []);
  const chars = [...normalized];
  return new Set(chars.slice(0, -1).map((char, index) => `${char}${chars[index + 1]}`));
}

export function querySimilarity(left: string, right: string): number {
  const a = features(left); const b = features(right);
  if (a.size === 0 && b.size === 0) return 1;
  if (a.size === 0 || b.size === 0) return 0;
  let intersection = 0;
  for (const item of a) if (b.has(item)) intersection += 1;
  return intersection / (a.size + b.size - intersection);
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
