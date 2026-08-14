import { createHash } from "node:crypto";
import type { DiscoveryResult, DiscoveredTool } from "../domain.js";
import { AppError } from "../errors.js";
import type { McpConnector } from "./connector.js";

const RESERVED_USER_QUESTION_FIELD = "__linkcli_user_question";

function usesReservedProperty(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(usesReservedProperty);
  if (!value || typeof value !== "object") return false;
  const object = value as Record<string, unknown>;
  const properties = object.properties;
  if (properties && typeof properties === "object" && !Array.isArray(properties) && RESERVED_USER_QUESTION_FIELD in properties) return true;
  return Object.values(object).some(usesReservedProperty);
}

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export function definitionHash(endpoint: string, protocolVersion: string, tools: DiscoveredTool[], projectToken: string | null): Buffer {
  const credentialFingerprint = projectToken ? createHash("sha256").update(projectToken).digest("hex") : null;
  return createHash("sha256").update(canonical({ endpoint, protocolVersion, credentialFingerprint, tools: [...tools].sort((a, b) => a.name.localeCompare(b.name)) })).digest();
}

export class DiscoveryService {
  constructor(private readonly connector: McpConnector, private readonly timeoutMs = 10_000) {}

  async discover(endpoint: string, token: string | null): Promise<DiscoveryResult> {
    let url: URL;
    try { url = new URL(endpoint); } catch { throw new AppError("INVALID_INPUT", "Endpoint must be a valid URL", 400); }
    if (!['http:', 'https:'].includes(url.protocol)) throw new AppError("INVALID_INPUT", "Only HTTP MCP endpoints are supported", 400);
    const result = await this.connector.discover(endpoint, token, this.timeoutMs);
    const names = new Set<string>();
    for (const tool of result.tools) {
      if (!tool.name.trim() || names.has(tool.name)) throw new AppError("CONFLICT", `Duplicate or empty tool name: ${tool.name}`, 409);
      names.add(tool.name);
      if (tool.inputSchema.type !== "object") throw new AppError("DOWNSTREAM_PROTOCOL_ERROR", `Tool ${tool.name} must expose an object input schema`, 422);
      if (usesReservedProperty(tool.inputSchema)) {
        throw new AppError("CONFLICT", `Tool ${tool.name} uses reserved field ${RESERVED_USER_QUESTION_FIELD}`, 409);
      }
    }
    return result;
  }
}
