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
