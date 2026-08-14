import { createHmac } from "node:crypto";
import type { AttributionContext, JsonObject, TransportSessionSource } from "../domain.js";
import { AppError } from "../errors.js";
import { USER_QUESTION_FIELD } from "../gateway/catalog.js";

export const CONVERSATION_META_KEY = "com.tolink.stats/conversation-id";
export const TURN_META_KEY = "com.tolink.stats/turn-id";
export const TURN_SEQUENCE_META_KEY = "com.tolink.stats/turn-sequence";
export const MAX_USER_QUESTION_LENGTH = 4_000;

const illegalControlCharacters = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u;
const genericQuestion = /^(请|帮我|麻烦|查询|查一下|处理一下|继续|好的|ok|okay|执行|调用)(一下|下|吧|。|！|!|\s)*$/iu;

export function normalizeQuestion(value: string): string {
  return value.normalize("NFC").trim().replace(/\s+/gu, " ");
}

function hmac(key: Buffer, ...parts: Array<string | null>): Buffer {
  const digest = createHmac("sha256", key);
  for (const part of parts) digest.update(part ?? "").update("\0");
  return digest.digest();
}

export const createExactTurnKey = (key: Buffer, credentialId: string, conversationId: string, turnId: string): Buffer => hmac(key, credentialId, conversationId, turnId);
export const createCandidateTurnKey = (key: Buffer, credentialId: string, transportSessionId: string | null, questionFingerprint: Buffer): Buffer => hmac(key, credentialId, transportSessionId, questionFingerprint.toString("hex"));

function optionalIdentifier(meta: Record<string, unknown>, key: string): string | null {
  const value = meta[key];
  if (value === undefined || value === null) return null;
  if (typeof value !== "string" || !value.trim() || value.length > 128 || illegalControlCharacters.test(value)) {
    throw new AppError("COLLECTION_CONTEXT_INVALID", `Invalid MCP attribution metadata: ${key}`, 400);
  }
  return value.trim();
}

function optionalSequence(meta: Record<string, unknown>): number | null {
  const value = meta[TURN_SEQUENCE_META_KEY];
  if (value === undefined || value === null) return null;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) {
    throw new AppError("COLLECTION_CONTEXT_INVALID", `Invalid MCP attribution metadata: ${TURN_SEQUENCE_META_KEY}`, 400);
  }
  return value;
}

function businessText(arguments_: JsonObject): string {
  return Object.entries(arguments_)
    .filter(([key]) => key !== USER_QUESTION_FIELD)
    .flatMap(([, value]) => {
      if (typeof value === "string" || typeof value === "number") return [String(value)];
      if (Array.isArray(value)) return value.filter((item): item is string | number => typeof item === "string" || typeof item === "number").map(String);
      return [];
    })
    .join(" ")
    .toLocaleLowerCase();
}

function qualitySignals(question: string, arguments_: JsonObject): string[] {
  const signals: string[] = [];
  if ([...question].length < 4) signals.push("question_too_short");
  if (genericQuestion.test(question)) signals.push("generic_or_template_question");
  const candidateTokens = question.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
  const parameters = businessText(arguments_);
  if (parameters && candidateTokens.length > 0 && !candidateTokens.some((token) => parameters.includes(token))) {
    signals.push("entity_non_overlap");
  }
  return signals;
}

export interface ResolveAttributionInput {
  credentialId: string;
  transportSessionId: string | null;
  transportSessionSource?: TransportSessionSource;
  arguments: JsonObject;
  meta?: Record<string, unknown>;
  fingerprintKey: Buffer;
}

export function resolveAttribution(input: ResolveAttributionInput): AttributionContext {
  const meta = input.meta ?? {};
  const conversationId = optionalIdentifier(meta, CONVERSATION_META_KEY);
  const clientTurnId = optionalIdentifier(meta, TURN_META_KEY);
  const clientTurnSequence = optionalSequence(meta);
  if ((conversationId === null) !== (clientTurnId === null)) {
    throw new AppError("COLLECTION_CONTEXT_INVALID", "conversation-id and turn-id must be supplied together", 400);
  }
  if (clientTurnSequence !== null && (!conversationId || !clientTurnId)) throw new AppError("COLLECTION_CONTEXT_INVALID", "turn-sequence requires conversation-id and turn-id", 400);
  const transportSessionId = input.transportSessionId?.trim() || null;
  if (transportSessionId && (transportSessionId.length > 128 || illegalControlCharacters.test(transportSessionId))) throw new AppError("COLLECTION_CONTEXT_INVALID", "Invalid transport session identifier", 400);
  const transportSessionSource = transportSessionId ? (input.transportSessionSource && input.transportSessionSource !== "missing" ? input.transportSessionSource : "custom") : "missing";

  const rawQuestion = input.arguments[USER_QUESTION_FIELD];
  let userQuestion: string | null = null;
  let normalizedQuestion: string | null = null;
  if (rawQuestion !== undefined && rawQuestion !== null) {
    if (typeof rawQuestion !== "string") throw new AppError("COLLECTION_CONTEXT_INVALID", `${USER_QUESTION_FIELD} must be a string`, 400);
    if (rawQuestion.length > MAX_USER_QUESTION_LENGTH || illegalControlCharacters.test(rawQuestion)) {
      throw new AppError("COLLECTION_CONTEXT_INVALID", `${USER_QUESTION_FIELD} is invalid`, 400);
    }
    normalizedQuestion = normalizeQuestion(rawQuestion);
    if (!normalizedQuestion) normalizedQuestion = null;
    userQuestion = rawQuestion;
  }

  const signals = normalizedQuestion ? qualitySignals(normalizedQuestion, input.arguments) : [];
  const questionFingerprint = normalizedQuestion ? hmac(input.fingerprintKey, normalizedQuestion) : null;
  if (conversationId && clientTurnId) {
    return {
      method: "client_turn",
      quality: signals.length ? "suspicious" : "trusted",
      qualitySignals: signals,
      conversationId,
      clientTurnId,
      clientTurnSequence,
      transportSessionId,
      transportSessionSource,
      userQuestion,
      questionFingerprint,
      exactTurnKey: createExactTurnKey(input.fingerprintKey, input.credentialId, conversationId, clientTurnId),
      candidateTurnKey: null,
    };
  }

  if (!normalizedQuestion) throw new AppError("COLLECTION_CONTEXT_INVALID", `${USER_QUESTION_FIELD} is required without exact turn metadata`, 400);
  const method = transportSessionId ? "session_question" : "credential_question";
  return {
    method,
    quality: signals.length ? "suspicious" : "inferred",
    qualitySignals: signals,
    conversationId: null,
    clientTurnId: null,
    clientTurnSequence: null,
    transportSessionId,
    transportSessionSource,
    userQuestion,
    questionFingerprint,
    exactTurnKey: null,
    candidateTurnKey: createCandidateTurnKey(input.fingerprintKey, input.credentialId, transportSessionId, questionFingerprint!),
  };
}
