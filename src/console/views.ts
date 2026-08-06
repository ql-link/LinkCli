import type { CallCredential, PlatformUser, Project, Review, ServiceVersion, ToolRuntime, ToolVersion } from "../domain.js";

export const userView = (user: PlatformUser) => ({ id:user.id, username:user.username, displayName:user.displayName, role:user.role, createdAt:user.createdAt, updatedAt:user.updatedAt });
export const versionView = (version: ServiceVersion) => ({ id:version.id, projectId:version.projectId, versionNo:version.versionNo, endpoint:version.endpoint, protocolVersion:version.protocolVersion, reviewStatus:version.reviewStatus, riskLevel:version.riskLevel, submittedBy:{id:version.submittedBy,displayName:null as string|null}, submittedAt:version.submittedAt, createdAt:version.createdAt });
export const projectView = (project: Project, versions: ServiceVersion[], tools: ToolVersion[]) => {
  const latest=[...versions].sort((a,b)=>b.versionNo-a.versionNo)[0]; const active=versions.find((item)=>item.id===project.activeVersionId);
  return { id:project.id, projectKey:project.projectKey, displayName:project.displayName, description:project.description, owner:{id:project.ownerId,displayName:null as string|null}, status:project.status, healthStatus:project.healthStatus, trustedReviewBypassEnabled:project.trustedReviewBypassEnabled, activeVersionNo:active?.versionNo??null, latestReviewStatus:latest?.reviewStatus??"draft", toolCount:tools.length, lastHealthCheckedAt:project.lastHealthCheckedAt, createdAt:project.createdAt, updatedAt:project.updatedAt };
};
export const toolView = (projectKey:string, tool:ToolVersion, runtime?:ToolRuntime) => ({ id:tool.id, originalName:tool.originalName, publicName:`${projectKey}__${tool.originalName}`, description:tool.description, inputSchema:tool.inputSchema, outputSchema:tool.outputSchema, riskLevel:tool.riskLevel, runtimeStatus:runtime?.status??"active", suspendedReason:runtime?.suspendedReason??null });
export const reviewView = (review: Review | null) => review ? ({ decision:review.decision, comment:review.comment, reviewer:{id:review.reviewerId,displayName:null as string|null}, decidedAt:review.decidedAt }) : null;
export const credentialView = (credential: Omit<CallCredential,"tokenDigest">) => ({ id:credential.id, credentialName:credential.credentialName, tokenPrefix:credential.tokenPrefix, expiresAt:credential.expiresAt, createdAt:credential.createdAt, revokedAt:credential.revokedAt, status:credential.revokedAt ? "revoked" : credential.expiresAt && credential.expiresAt <= new Date() ? "expired" : "active" });
export function diffTools(projectKey:string, before:ToolVersion[], after:ToolVersion[]) {
  const names=[...new Set([...before.map(t=>t.originalName),...after.map(t=>t.originalName)])].sort();
  return names.map((name)=>{ const left=before.find(t=>t.originalName===name); const right=after.find(t=>t.originalName===name); let change="unchanged";
    if (!left) change="added"; else if (!right) change="removed"; else if (left.description!==right.description) change="description_changed"; else if (JSON.stringify(left.inputSchema)!==JSON.stringify(right.inputSchema)) change="input_changed"; else if (JSON.stringify(left.outputSchema)!==JSON.stringify(right.outputSchema)) change="output_changed";
    return {name,change,before:left?toolView(projectKey,left):null,after:right?toolView(projectKey,right):null}; });
}
