import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { CallCredential } from "../domain.js";
import type { RegistryRepository } from "../db/repository.js";
import { AppError, assertFound } from "../errors.js";

const digest = (token: string): Buffer => createHash("sha256").update(token).digest();

export class CredentialService {
  constructor(private readonly repository: RegistryRepository, private readonly maxPerOwner = 20) {}

  async issue(ownerId: string, credentialName: string, expiresAt: Date | null): Promise<{ credential: CallCredential; token: string }> {
    if (!credentialName.trim()) throw new AppError("INVALID_INPUT", "Credential name is required", 400);
    const existing = await this.repository.listCallCredentials(ownerId);
    if (existing.filter((item) => !item.revokedAt && (!item.expiresAt || item.expiresAt > new Date())).length >= this.maxPerOwner) {
      throw new AppError("CONFLICT", "Active credential limit reached", 409);
    }
    const now = new Date();
    if (expiresAt && expiresAt <= now) throw new AppError("INVALID_INPUT", "Credential expiry must be in the future", 400);
    const token = `lkc_${randomBytes(32).toString("base64url")}`;
    const credential: CallCredential = { id: randomUUID(), ownerId, credentialName: credentialName.trim(), tokenPrefix: token.slice(0, 12), tokenDigest: digest(token), expiresAt, createdAt: now, revokedAt: null };
    await this.repository.createCallCredential(credential);
    return { credential, token };
  }

  async authenticate(token: string | null | undefined): Promise<CallCredential> {
    if (!token) throw new AppError("AUTHENTICATION_FAILED", "Platform credential is required", 401);
    const credential = await this.repository.getCallCredentialByDigest(digest(token));
    if (!credential || credential.revokedAt || (credential.expiresAt && credential.expiresAt <= new Date())) {
      throw new AppError("AUTHENTICATION_FAILED", "Platform credential is invalid, expired, or revoked", 401);
    }
    return credential;
  }

  async revoke(id: string, ownerId: string): Promise<CallCredential> {
    const credential = assertFound(await this.repository.getCallCredential(id), "Credential not found");
    if (credential.ownerId !== ownerId) throw new AppError("AUTHORIZATION_FAILED", "Credential belongs to another owner", 403);
    if (!credential.revokedAt) { credential.revokedAt = new Date(); await this.repository.updateCallCredential(credential); }
    return credential;
  }

  async list(ownerId: string): Promise<Array<Omit<CallCredential, "tokenDigest">>> {
    return (await this.repository.listCallCredentials(ownerId)).map(({ tokenDigest: _digest, ...credential }) => credential);
  }
}

export function bearerToken(header: string | undefined): string | null {
  if (!header) return null;
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1] ?? null;
}
