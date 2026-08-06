import { createHash } from "node:crypto";
import type { JsonObject } from "../domain.js";

const sensitive = /authorization|token|secret|password|credential|api[_-]?key/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [key, sensitive.test(key) ? "[REDACTED]" : sanitize(item, depth + 1)]));
  }
  if (typeof value === "string") return { type: "string", length: value.length, sha256: createHash("sha256").update(value).digest("hex").slice(0, 16) };
  return value;
}

const summary = (value: unknown): string => JSON.stringify(sanitize(value)).slice(0, 2_000);

export interface CallEnvelope {
  turnId: string;
  platformOwnerId: string;
  sessionId: string;
  callSequence: number;
  projectKey: string;
  toolName: string;
  userQuestion: string;
  argumentsSummary: string;
  resultSummary: string;
  outcome: "success" | "error";
  durationMs: number;
  occurredAt: string;
}

export interface EnvelopeInput {
  platformOwnerId: string;
  sessionId: string;
  callSequence: number;
  projectKey: string;
  toolName: string;
  userQuestion: string;
  arguments: JsonObject;
  result: unknown;
  outcome: "success" | "error";
  durationMs: number;
  occurredAt?: Date;
}

export function createEnvelope(input: EnvelopeInput): CallEnvelope {
  const turnId = createHash("sha256").update(`${input.platformOwnerId}\0${input.sessionId}\0${input.callSequence}`).digest("base64url").slice(0, 32);
  return { turnId, platformOwnerId: input.platformOwnerId, sessionId: input.sessionId, callSequence: input.callSequence, projectKey: input.projectKey, toolName: input.toolName,
    userQuestion: input.userQuestion.slice(0, 1_000), argumentsSummary: summary(input.arguments), resultSummary: summary(input.result), outcome: input.outcome,
    durationMs: input.durationMs, occurredAt: (input.occurredAt ?? new Date()).toISOString() };
}
