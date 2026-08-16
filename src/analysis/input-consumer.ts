import { modulePathOf, queryFingerprint } from "./similarity.js";
import type { AnalysisCall, AnalysisInput, CollectionTrust, SettlementStatus } from "./types.js";
import type { AnalysisRepository } from "./repository.js";

export interface SettledTurnInput {
  eventId: string;
  turnId: string;
  settlementVersion: number;
  actorHash: string;
  queryText: string;
  calls: AnalysisCall[];
  behaviorSignals?: Record<string, boolean | number | string>;
  settlementStatus: SettlementStatus;
  collectionTrust: CollectionTrust;
  attemptedSkillId?: string;
  attemptedSkillVersion?: string;
  occurredAt: Date;
}

function assertInput(input: SettledTurnInput): void {
  if (!input.eventId.trim() || !input.turnId.trim()) throw new Error("eventId and turnId are required");
  if (!Number.isInteger(input.settlementVersion) || input.settlementVersion < 1) throw new Error("settlementVersion must be a positive integer");
  if (!/^[0-9a-f]{64}$/i.test(input.actorHash)) throw new Error("actorHash must be a SHA-256 hex digest");
  if (!input.queryText.trim()) throw new Error("queryText is required");
  const sequences = input.calls.map((call) => call.sequence);
  if (new Set(sequences).size !== sequences.length || sequences.some((value) => !Number.isInteger(value) || value < 1)) throw new Error("call sequence must be unique positive integers");
  if ((input.settlementStatus === "zero_call" || input.settlementStatus === "unmatched") && input.calls.length !== 0) throw new Error(`${input.settlementStatus} input cannot contain calls`);
}

export class AnalysisInputConsumer {
  constructor(private readonly repository: AnalysisRepository) {}
  async accept(input: SettledTurnInput): Promise<boolean> {
    assertInput(input);
    const path = modulePathOf(input.calls);
    const record: AnalysisInput = {
      eventId: input.eventId.trim(), turnId: input.turnId.trim(), settlementVersion: input.settlementVersion,
      actorHash: input.actorHash.toLowerCase(), queryText: input.queryText.slice(0, 4_000), queryFingerprint: queryFingerprint(input.queryText),
      projectScope: path.projectScope, modulePathHash: path.modulePathHash, modulePath: path.modulePath,
      calls: input.calls.map((call) => ({ ...call, parameterKeys: [...new Set(call.parameterKeys)].sort() })),
      behaviorSignals: input.behaviorSignals ?? null, settlementStatus: input.settlementStatus, collectionTrust: input.collectionTrust,
      attemptedSkillId: input.attemptedSkillId?.trim() || null, attemptedSkillVersion: input.attemptedSkillVersion?.trim() || null,
      occurredAt: new Date(input.occurredAt), analyzedAt: null,
    };
    return this.repository.insertInput(record);
  }
}
