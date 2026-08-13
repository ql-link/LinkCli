import { createHash, randomUUID } from "node:crypto";
import type { JsonObject } from "../domain.js";

const sensitive = /authorization|token|secret|password|credential|api[_-]?key/i;

function sanitize(value: unknown, depth = 0): unknown {
  if (depth > 5) return "[TRUNCATED]";
  if (Buffer.isBuffer(value)) return { type: "binary", length: value.length, sha256: createHash("sha256").update(value).digest("hex").slice(0, 16) };
  if (Array.isArray(value)) return value.slice(0, 20).map((item) => sanitize(item, depth + 1));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).slice(0, 50).map(([key, item]) => [key, sensitive.test(key) ? "[REDACTED]" : sanitize(item, depth + 1)]));
  }
  if (typeof value === "string") return { type: "string", length: value.length, sha256: createHash("sha256").update(value).digest("hex").slice(0, 16) };
  if (typeof value === "number") return { type: "number" };
  if (typeof value === "boolean") return { type: "boolean" };
  if (typeof value === "bigint") return { type: "bigint" };
  return value === null ? null : { type: typeof value };
}

export const summarize = (value: unknown): JsonObject => {
  const sanitized = sanitize(value);
  if (sanitized && typeof sanitized === "object" && !Array.isArray(sanitized)) return sanitized as JsonObject;
  return { value: sanitized };
};

export function createEventId(): string {
  return randomUUID();
}
