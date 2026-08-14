export type JsonObject = Record<string, unknown>;
export type ProjectStatus = "pending" | "active" | "disabled" | "retired";
export type HealthStatus = "unknown" | "healthy" | "unhealthy";
export type ReviewStatus = "draft" | "pending_review" | "approved" | "rejected";
export type RiskLevel = "low" | "medium" | "high" | "incompatible";
export type ToolRuntimeStatus = "active" | "suspended";
export type ReviewDecision = "approved" | "rejected" | "bypassed";

export interface Project {
  id: string;
  projectKey: string;
  displayName: string;
  description: string;
  ownerId: string;
  status: ProjectStatus;
  trustedReviewBypassEnabled: boolean;
  activeVersionId: string | null;
  healthStatus: HealthStatus;
  lastHealthCheckedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface ServiceVersion {
  id: string;
  projectId: string;
  versionNo: number;
  endpoint: string;
  protocolVersion: string;
  credentialCiphertext: string | null;
  credentialKeyId: string | null;
  reviewStatus: ReviewStatus;
  riskLevel: RiskLevel;
  definitionHash: Buffer;
  submittedBy: string;
  submittedAt: Date | null;
  createdAt: Date;
}

export interface ToolVersion {
  id: string;
  serviceVersionId: string;
  originalName: string;
  moduleKey: string | null;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
  riskLevel: RiskLevel;
}

export interface ToolRuntime {
  projectId: string;
  originalName: string;
  status: ToolRuntimeStatus;
  suspendedReason: string | null;
  updatedAt: Date;
}

export interface Review {
  serviceVersionId: string;
  decision: ReviewDecision;
  comment: string | null;
  reviewerId: string;
  decidedAt: Date;
}

export interface CallCredential {
  id: string;
  ownerId: string;
  credentialName: string;
  tokenPrefix: string;
  tokenDigest: Buffer;
  expiresAt: Date | null;
  createdAt: Date;
  revokedAt: Date | null;
}

export interface CatalogEntry {
  publicName: string;
  project: Project;
  version: ServiceVersion;
  tool: ToolVersion;
}

export interface DiscoveredTool {
  name: string;
  description: string;
  inputSchema: JsonObject;
  outputSchema: JsonObject | null;
}

export interface DiscoveryResult {
  protocolVersion: string;
  tools: DiscoveredTool[];
}

export interface PlatformIdentity {
  userId: string;
  role: "owner" | "reviewer" | "operator" | "platform_user";
}

export type UserRole = "member" | "reviewer" | "operator";

export interface PlatformUser {
  id: string;
  username: string;
  displayName: string;
  passwordHash: string;
  role: UserRole;
  createdAt: Date;
  updatedAt: Date;
}

export interface PlatformSession {
  id: string;
  userId: string;
  tokenDigest: Buffer;
  expiresAt: Date;
  lastSeenAt: Date;
  createdAt: Date;
  revokedAt: Date | null;
}

export type AttributionMethod = "client_turn" | "session_question" | "credential_question" | "unavailable";
export type AttributionQuality = "trusted" | "inferred" | "suspicious" | "missing" | "partial";
export type CallRecordStatus = "started" | "completed" | "partial";
export type CallOutcome = "success" | "error" | "unknown";
export type DeliveryStatus = "waiting" | "ready" | "processing" | "delivered" | "dead_letter";
export type TurnLifecycleStatus = "collecting" | "grace" | "finalized";
export type TurnSettlementStatus = "pending" | "succeeded" | "failed";
export type TransportSessionSource = "mcp" | "custom" | "missing";

export interface AttributionContext {
  method: AttributionMethod;
  quality: AttributionQuality;
  qualitySignals: string[];
  conversationId: string | null;
  clientTurnId: string | null;
  clientTurnSequence: number | null;
  transportSessionId: string | null;
  transportSessionSource: TransportSessionSource;
  userQuestion: string | null;
  questionFingerprint: Buffer | null;
  exactTurnKey: Buffer | null;
  candidateTurnKey: Buffer | null;
}

export interface CallOutboxRecord {
  id: string;
  ingressSequence: number;
  platformOwnerId: string;
  credentialId: string;
  projectId: string;
  serviceVersionId: string;
  toolVersionId: string;
  projectKey: string;
  toolName: string;
  argumentsSummary: JsonObject;
  resultSummary: JsonObject | null;
  attribution: AttributionContext;
  status: CallRecordStatus;
  outcome: CallOutcome;
  errorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  deliveryStatus: DeliveryStatus;
  deliveryAttempts: number;
  nextAttemptAt: Date;
  leaseOwner: string | null;
  leaseExpiresAt: Date | null;
  deliveredAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CallEvent {
  id: string;
  turnId: string | null;
  ingressSequence: number;
  platformOwnerId: string;
  credentialId: string;
  projectId: string;
  serviceVersionId: string;
  toolVersionId: string;
  projectKey: string;
  toolName: string;
  userQuestion: string | null;
  attributionMethod: AttributionMethod;
  attributionQuality: AttributionQuality;
  qualitySignals: string[];
  argumentsSummary: JsonObject;
  resultSummary: JsonObject | null;
  status: CallRecordStatus;
  outcome: CallOutcome;
  errorCode: string | null;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number | null;
  createdAt: Date;
}

export interface ConversationTurn {
  id: string;
  platformOwnerId: string;
  credentialId: string;
  conversationId: string | null;
  clientTurnId: string | null;
  clientTurnSequence: number | null;
  exactTurnKey: Buffer | null;
  candidateTurnKey: Buffer | null;
  attributionMethod: AttributionMethod;
  attributionQuality: AttributionQuality;
  userQuestion: string | null;
  questionFingerprint: Buffer | null;
  lifecycleStatus: TurnLifecycleStatus;
  settlementStatus: TurnSettlementStatus;
  callCount: number;
  successCount: number;
  errorCount: number;
  partialCount: number;
  firstEventAt: Date;
  lastEventAt: Date;
  graceUntil: Date | null;
  finalizedAt: Date | null;
  revision: number;
  settledRevision: number;
  canonicalChain: JsonObject | null;
  createdAt: Date;
  updatedAt: Date;
}
