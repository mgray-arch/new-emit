import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { isEmitPermission, isEmitProfile, permissionFromRole, type EmitPermission, type EmitProfile, type PortalRole, type Session } from "@/lib/types";

/** Failed attempts against one email before that email is locked. */
export const LOGIN_EMAIL_LIMIT = 5;
/** Failed attempts from one IP before that IP is locked, so one address cannot spray the user list. */
export const LOGIN_IP_LIMIT = 30;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const PASSWORD_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";

let dummyHash: string | null = null;

function dummy(): string {
  dummyHash ??= bcrypt.hashSync("not-a-real-password", 8);
  return dummyHash;
}

export interface UserRow {
  id: string;
  email: string;
  name: string;
  role: PortalRole;
  permission?: EmitPermission | null;
  profile?: EmitProfile | null;
  password_hash: string | null;
  active: number;
  password_changed_at: string | null;
  password_epoch: number;
  chat_enabled?: number | null;
}

export type LoginResult =
  | { ok: true; session: Session }
  | { ok: false; reason: "invalid" | "locked" | "inactive"; retryAfterSeconds?: number };

export function passwordError(password: string): string | null {
  if (password.length < 10) return "Use at least 10 characters.";
  if (password.length > 200) return "That password is too long.";
  return null;
}

export function hashPassword(password: string): string {
  const problem = passwordError(password);
  if (problem) throw new PortalError(problem);
  return bcrypt.hashSync(password, 10);
}

export function generateTemporaryPassword(): string {
  const chars: string[] = [];
  const limit = 256 - (256 % PASSWORD_ALPHABET.length);
  while (chars.length < 16) {
    for (const byte of randomBytes(32)) {
      if (byte >= limit) continue;
      chars.push(PASSWORD_ALPHABET[byte % PASSWORD_ALPHABET.length]);
      if (chars.length === 16) break;
    }
  }
  return chars.join("");
}

export function clientIp(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for")?.split(",")[0]?.trim();
  const ip = forwarded || req.headers.get("x-real-ip")?.trim() || "unknown";
  return ip.slice(0, 80) || "unknown";
}

export async function findUser(ctx: PortalContext, email: string): Promise<UserRow | null> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, permission, profile, password_hash, active, password_changed_at, password_epoch, chat_enabled FROM users WHERE email = ?`,
    )
    .get(email.trim().toLowerCase())) as UserRow | undefined;
  return row ?? null;
}

export async function findUserById(ctx: PortalContext, id: string): Promise<UserRow | null> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, permission, profile, password_hash, active, password_changed_at, password_epoch, chat_enabled FROM users WHERE id = ?`,
    )
    .get(id)) as UserRow | undefined;
  return row ?? null;
}

function windowStart(ctx: PortalContext): string {
  return new Date(ctx.now().getTime() - LOGIN_WINDOW_MS).toISOString();
}

async function attemptCount(ctx: PortalContext, bucket: string): Promise<number> {
  const row = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE bucket = ? AND created_at >= ?`)
    .get(bucket, windowStart(ctx));
  return Number(row?.n ?? 0);
}

export async function loginLockStatus(
  ctx: PortalContext,
  email: string,
  ip: string,
): Promise<{ locked: boolean; retryAfterSeconds: number }> {
  const emailCount = await attemptCount(ctx, `email:${email}`);
  const ipCount = await attemptCount(ctx, `ip:${ip}`);
  const locked = emailCount >= LOGIN_EMAIL_LIMIT || ipCount >= LOGIN_IP_LIMIT;
  return { locked, retryAfterSeconds: locked ? Math.ceil(LOGIN_WINDOW_MS / 1000) : 0 };
}

async function recordFailure(ctx: PortalContext, email: string, ip: string): Promise<void> {
  const now = ctx.now().toISOString();
  const insert = ctx.db.prepare(`INSERT INTO login_attempts (id, bucket, created_at) VALUES (?, ?, ?)`);
  await insert.run(randomUUID(), `email:${email}`, now);
  await insert.run(randomUUID(), `ip:${ip}`, now);
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE created_at < ?`).run(windowStart(ctx));
}

async function clearEmailFailures(ctx: PortalContext, email: string): Promise<void> {
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE bucket = ?`).run(`email:${email}`);
}

export async function loginWithPassword(
  ctx: PortalContext,
  email: string,
  password: string,
  ip: string,
): Promise<LoginResult> {
  const normalized = email.trim().toLowerCase();
  const locked = await loginLockStatus(ctx, normalized, ip);
  if (locked.locked) return { ok: false, reason: "locked", retryAfterSeconds: locked.retryAfterSeconds };
  const user = await findUser(ctx, normalized);
  const ok = bcrypt.compareSync(password, user?.password_hash || dummy());
  if (!user?.password_hash || !ok) {
    await recordFailure(ctx, normalized, ip);
    const after = await loginLockStatus(ctx, normalized, ip);
    if (after.locked) return { ok: false, reason: "locked", retryAfterSeconds: after.retryAfterSeconds };
    return { ok: false, reason: "invalid" };
  }
  if (Number(user.active) === 0) return { ok: false, reason: "inactive" };
  await clearEmailFailures(ctx, normalized);
  return {
    ok: true,
    session: sessionFromUser(user),
  };
}

export function sessionFromUser(user: UserRow): Session {
  return {
    userId: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    permission: storedPermission(user.role, user.permission),
    profile: isEmitProfile(user.profile) ? user.profile : null,
    passwordEpoch: Number(user.password_epoch ?? 0),
  };
}

function storedPermission(role: string, permission: string | null | undefined): EmitPermission | null {
  if (role === "admin") return null;
  if (isEmitPermission(permission)) return permission;
  return permissionFromRole(role);
}

/**
 * A live session must still match an active user. Test fixtures use a signed
 * session whose user id is not in the database; those keep working only while
 * PORTAL_TEST_MODE is on. Production rejects a missing or deactivated user,
 * and a session from before the password was changed.
 */
export async function assertSessionLive(
  ctx: PortalContext,
  session: Session & { issuedAt?: number },
): Promise<Session | null> {
  const user = await findUserById(ctx, session.userId);
  if (!user) {
    if (process.env.PORTAL_TEST_MODE === "1" && process.env.NODE_ENV !== "production") return session;
    return null;
  }
  if (Number(user.active) === 0) return null;
  if (Number(user.password_epoch ?? 0) !== (session.passwordEpoch ?? 0)) return null;
  return sessionFromUser(user);
}

/** Microsoft sign-in returns customer. That must not change a permission Select already set. */
function preservedRole(existing: PortalRole, incoming: PortalRole): PortalRole {
  if (existing === "admin") return "admin";
  if ((existing === "emit_admin" || existing === "emit_viewer" || existing === "customer") && incoming === "customer") {
    return existing;
  }
  return incoming;
}

export async function upsertExternalUser(
  ctx: PortalContext,
  input: { email: string; name: string; role: PortalRole },
): Promise<Session> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUser(ctx, email);
  if (existing) {
    if (Number(existing.active) === 0) throw new PortalError("This account is deactivated.", 403);
    const role = preservedRole(existing.role, input.role);
    await ctx.db
      .prepare(`UPDATE users SET name = ?, role = ? WHERE id = ?`)
      .run(input.name || existing.name, role, existing.id);
    return {
      userId: existing.id,
      email,
      name: input.name || existing.name,
      role,
      permission: storedPermission(role, existing.permission),
      profile: isEmitProfile(existing.profile) ? existing.profile : null,
    };
  }
  const id = randomUUID();
  const permission = input.role === "admin" ? null : storedPermission(input.role, null);
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, permission, password_hash, active, created_at) VALUES (?, ?, ?, ?, ?, NULL, 1, ?)`,
    )
    .run(id, email, input.name || email, input.role, permission, new Date().toISOString());
  return { userId: id, email, name: input.name || email, role: input.role, permission };
}

export async function setPasswordHash(ctx: PortalContext, userId: string, password: string): Promise<number> {
  const user = await findUserById(ctx, userId);
  if (!user) throw new PortalError("User not found", 404);
  const hash = hashPassword(password);
  const epoch = Number(user.password_epoch ?? 0) + 1;
  const updated = await ctx.db
    .prepare(`UPDATE users SET password_hash = ?, password_changed_at = ?, password_epoch = ? WHERE id = ?`)
    .run(hash, ctx.now().toISOString(), epoch, userId);
  if (!updated.changes) throw new PortalError("User not found", 404);
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE bucket = ?`).run(`email:${user.email}`);
  return epoch;
}

export async function changeOwnPassword(
  ctx: PortalContext,
  session: Session,
  currentPassword: string,
  newPassword: string,
): Promise<Session> {
  const user = await findUserById(ctx, session.userId);
  if (!user) throw new PortalError("User not found", 404);
  if (Number(user.active) === 0) throw new PortalError("This account is deactivated.", 403);
  if (!user.password_hash) throw new PortalError("This account signs in with Google. There is no password to change.");
  if (!bcrypt.compareSync(currentPassword, user.password_hash)) {
    throw new PortalError("Current password is wrong.");
  }
  if (currentPassword === newPassword) throw new PortalError("Choose a different password.");
  const passwordEpoch = await setPasswordHash(ctx, user.id, newPassword);
  return { ...sessionFromUser({ ...user, password_epoch: passwordEpoch }), passwordEpoch };
}
