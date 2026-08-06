import type { Pool, PoolConnection, RowDataPacket } from "mysql2/promise";
import type { PlatformSession, PlatformUser, UserRole } from "../domain.js";
import { AppError } from "../errors.js";

export interface IdentityRepository {
  createUser(user: PlatformUser): Promise<void>;
  getUserById(id: string): Promise<PlatformUser | null>;
  getUserByUsername(username: string): Promise<PlatformUser | null>;
  updateUser(user: PlatformUser): Promise<void>;
  listUsers(): Promise<PlatformUser[]>;
  countUsersByRole(role: UserRole): Promise<number>;
  createSession(session: PlatformSession): Promise<void>;
  getSessionByDigest(digest: Buffer): Promise<PlatformSession | null>;
  updateSession(session: PlatformSession): Promise<void>;
}

function clone<T>(value:T):T {
  if(Buffer.isBuffer(value)) return Buffer.from(value) as T;
  if(value instanceof Date) return new Date(value) as T;
  if(Array.isArray(value)) return value.map(clone) as T;
  if(value&&typeof value==="object") return Object.fromEntries(Object.entries(value as Record<string,unknown>).map(([key,item])=>[key,clone(item)])) as T;
  return value;
}

export class MemoryIdentityRepository implements IdentityRepository {
  private readonly users = new Map<string, PlatformUser>();
  private readonly sessions = new Map<string, PlatformSession>();
  async createUser(user: PlatformUser): Promise<void> {
    if ([...this.users.values()].some((item) => item.username === user.username)) throw new AppError("USERNAME_TAKEN", "Username is already in use", 409);
    this.users.set(user.id, clone(user));
  }
  async getUserById(id: string): Promise<PlatformUser | null> { return clone(this.users.get(id) ?? null); }
  async getUserByUsername(username: string): Promise<PlatformUser | null> { return clone([...this.users.values()].find((item) => item.username === username) ?? null); }
  async updateUser(user: PlatformUser): Promise<void> { this.users.set(user.id, clone(user)); }
  async listUsers(): Promise<PlatformUser[]> { return clone([...this.users.values()].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())); }
  async countUsersByRole(role: UserRole): Promise<number> { return [...this.users.values()].filter((item) => item.role === role).length; }
  async createSession(session: PlatformSession): Promise<void> { this.sessions.set(session.tokenDigest.toString("hex"), clone(session)); }
  async getSessionByDigest(digest: Buffer): Promise<PlatformSession | null> { return clone(this.sessions.get(digest.toString("hex")) ?? null); }
  async updateSession(session: PlatformSession): Promise<void> { this.sessions.set(session.tokenDigest.toString("hex"), clone(session)); }
}

type Executor = Pool | PoolConnection;
const date = (value: unknown): Date => value instanceof Date ? value : new Date(String(value));
const nullableDate = (value: unknown): Date | null => value === null ? null : date(value);
const isDuplicate = (error: unknown): boolean => Boolean(error && typeof error === "object" && "code" in error && (error as { code?: unknown }).code === "ER_DUP_ENTRY");
const userFrom = (row: RowDataPacket): PlatformUser => ({ id: row.id, username: row.username, displayName: row.display_name, passwordHash: row.password_hash, role: row.role, createdAt: date(row.created_at), updatedAt: date(row.updated_at) });
const sessionFrom = (row: RowDataPacket): PlatformSession => ({ id: row.id, userId: row.user_id, tokenDigest: Buffer.from(row.token_digest), expiresAt: date(row.expires_at), lastSeenAt: date(row.last_seen_at), createdAt: date(row.created_at), revokedAt: nullableDate(row.revoked_at) });

export class MySqlIdentityRepository implements IdentityRepository {
  constructor(private readonly executor: Executor) {}
  async createUser(user: PlatformUser): Promise<void> {
    try {
      await this.executor.execute("INSERT INTO platform_users (id,username,display_name,password_hash,role,created_at,updated_at) VALUES (?,?,?,?,?,?,?)", [user.id,user.username,user.displayName,user.passwordHash,user.role,user.createdAt,user.updatedAt]);
    } catch (error) { if (isDuplicate(error)) throw new AppError("USERNAME_TAKEN", "Username is already in use", 409); throw error; }
  }
  async getUserById(id: string): Promise<PlatformUser | null> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM platform_users WHERE id=?",[id]); return rows[0] ? userFrom(rows[0]) : null; }
  async getUserByUsername(username: string): Promise<PlatformUser | null> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM platform_users WHERE username=?",[username]); return rows[0] ? userFrom(rows[0]) : null; }
  async updateUser(user: PlatformUser): Promise<void> { await this.executor.execute("UPDATE platform_users SET display_name=?,role=?,updated_at=? WHERE id=?",[user.displayName,user.role,user.updatedAt,user.id]); }
  async listUsers(): Promise<PlatformUser[]> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM platform_users ORDER BY created_at DESC,id DESC"); return rows.map(userFrom); }
  async countUsersByRole(role: UserRole): Promise<number> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT COUNT(*) count FROM platform_users WHERE role=?",[role]); return Number(rows[0]?.count ?? 0); }
  async createSession(s: PlatformSession): Promise<void> { await this.executor.execute("INSERT INTO platform_sessions (id,user_id,token_digest,expires_at,last_seen_at,created_at,revoked_at) VALUES (?,?,?,?,?,?,?)",[s.id,s.userId,s.tokenDigest,s.expiresAt,s.lastSeenAt,s.createdAt,s.revokedAt]); }
  async getSessionByDigest(digest: Buffer): Promise<PlatformSession | null> { const [rows]=await this.executor.query<RowDataPacket[]>("SELECT * FROM platform_sessions WHERE token_digest=?",[digest]); return rows[0] ? sessionFrom(rows[0]) : null; }
  async updateSession(s: PlatformSession): Promise<void> { await this.executor.execute("UPDATE platform_sessions SET expires_at=?,last_seen_at=?,revoked_at=? WHERE id=?",[s.expiresAt,s.lastSeenAt,s.revokedAt,s.id]); }
}
