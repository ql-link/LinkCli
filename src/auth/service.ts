import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PlatformSession, PlatformUser, UserRole } from "../domain.js";
import { AppError, assertFound } from "../errors.js";
import { hashPassword, verifyPassword } from "./password.js";
import type { IdentityRepository } from "./repository.js";

const SESSION_MS = 7 * 24 * 60 * 60 * 1000;
const RENEW_WHEN_REMAINING_MS = 6 * 24 * 60 * 60 * 1000;
const DUMMY_HASH = hashPassword("linkcli-dummy-password-never-used");
export const sessionDigest = (token: string): Buffer => createHash("sha256").update(token).digest();

export interface AuthenticatedSession { user: PlatformUser; session: PlatformSession; renewed: boolean; }

export class IdentityService {
  constructor(private readonly repository: IdentityRepository) {}

  async register(username: string, displayName: string, password: string, role: UserRole = "member"): Promise<PlatformUser> {
    const normalized = username.trim();
    if (!/^[A-Za-z0-9._-]{3,64}$/.test(normalized)) throw new AppError("INVALID_INPUT", "Username must be 3-64 letters, numbers, dots, underscores or hyphens", 400);
    if (!displayName.trim() || displayName.trim().length > 120) throw new AppError("INVALID_INPUT", "Display name is required", 400);
    if (password.length < 12 || password.length > 128) throw new AppError("INVALID_INPUT", "Password must be 12-128 characters", 400);
    const now = new Date();
    const user: PlatformUser = { id: randomUUID(), username: normalized, displayName: displayName.trim(), passwordHash: await hashPassword(password), role, createdAt: now, updatedAt: now };
    await this.repository.createUser(user);
    return user;
  }

  async login(username: string, password: string): Promise<{ user: PlatformUser; session: PlatformSession; token: string }> {
    const user = await this.repository.getUserByUsername(username.trim());
    const valid = await verifyPassword(user?.passwordHash ?? await DUMMY_HASH, password);
    if (!user || !valid) throw new AppError("AUTHENTICATION_FAILED", "Username or password is incorrect", 401);
    const token = randomBytes(32).toString("base64url"); const now = new Date();
    const session: PlatformSession = { id: randomUUID(), userId: user.id, tokenDigest: sessionDigest(token), expiresAt: new Date(now.getTime() + SESSION_MS), lastSeenAt: now, createdAt: now, revokedAt: null };
    await this.repository.createSession(session); return { user, session, token };
  }

  async authenticate(token: string): Promise<AuthenticatedSession> {
    const session = await this.repository.getSessionByDigest(sessionDigest(token)); const now = new Date();
    if (!session || session.revokedAt || session.expiresAt <= now) throw new AppError("AUTHENTICATION_REQUIRED", "Login is required", 401);
    const user = assertFound(await this.repository.getUserById(session.userId), "Account not found");
    const renewed = session.expiresAt.getTime() - now.getTime() < RENEW_WHEN_REMAINING_MS;
    session.lastSeenAt = now;
    if (renewed) session.expiresAt = new Date(now.getTime() + SESSION_MS);
    if (renewed) await this.repository.updateSession(session);
    return { user, session, renewed };
  }

  async logout(token: string): Promise<void> { const session = await this.repository.getSessionByDigest(sessionDigest(token)); if (!session || session.revokedAt) return; session.revokedAt = new Date(); await this.repository.updateSession(session); }
  async updateDisplayName(userId: string, displayName: string): Promise<PlatformUser> { const user=assertFound(await this.repository.getUserById(userId),"Account not found"); if (!displayName.trim() || displayName.trim().length > 120) throw new AppError("INVALID_INPUT","Display name is required",400); user.displayName=displayName.trim(); user.updatedAt=new Date(); await this.repository.updateUser(user); return user; }
  async listUsers(): Promise<PlatformUser[]> { return this.repository.listUsers(); }
  async getUser(id: string): Promise<PlatformUser | null> { return this.repository.getUserById(id); }
  async changeRole(actorId: string, userId: string, role: UserRole): Promise<PlatformUser> {
    if (actorId === userId) throw new AppError("INVALID_STATE", "You cannot change your own role", 409);
    const user=assertFound(await this.repository.getUserById(userId),"Account not found");
    if (user.role === "operator" && role !== "operator" && await this.repository.countUsersByRole("operator") <= 1) throw new AppError("INVALID_STATE","The last operator cannot be demoted",409);
    user.role=role; user.updatedAt=new Date(); await this.repository.updateUser(user); return user;
  }
}
