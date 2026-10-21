import bcrypt from "bcryptjs";
import { randomBytes, randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import type { PortalRole, Session } from "@/lib/types";

/**
 * EMIT staff sign in with email and password. This is the production path.
 * Select admins sign in with Google and do not need a password.
 * Microsoft remains optional and is not required for a user to exist.
 */

let dummyHash: string | null = null;

function dummy(): string {
  dummyHash ??= bcrypt.hashSync("not-a-real-password", 8);
  return dummyHash;
}

export const MIN_PASSWORD_LENGTH = 10;
export const LOGIN_FAILURE_LIMIT = 5;
export const LOGIN_IP_FAILURE_LIMIT = 20;
export const LOGIN_WINDOW_MS = 15 * 60 * 1000;

const LOCKOUT_MESSAGE = "Too many sign-in attempts. Try again in 15 minutes.";

export interface PortalUser {
  id: string;
  email: string;
  name: string;
  role: PortalRole;
  passwordHash: string | null;
  active: boolean;
  mustChangePassword: boolean;
}

export type PasswordLoginResult =
  | { ok: true; session: Session; mustChangePassword: boolean }
  | { ok: false; status: 401 | 403 | 429; error: string };

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: PortalRole;
  password_hash: string | null;
  active: number | null;
  must_change_password: number | null;
}

function mapUser(row: UserRow): PortalUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    role: row.role,
    passwordHash: row.password_hash,
    active: Number(row.active ?? 1) !== 0,
    mustChangePassword: Number(row.must_change_password ?? 0) !== 0,
  };
}

export function hashPassword(password: string): string {
  return bcrypt.hashSync(password, 10);
}

export function generateTemporaryPassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  const bytes = randomBytes(16);
  let raw = "";
  for (let index = 0; index < 16; index += 1) raw += alphabet[bytes[index] % alphabet.length];
  return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
}

export function assertPasswordStrength(password: string): void {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new PortalError(`Use at least ${MIN_PASSWORD_LENGTH} characters.`);
  }
  if (password.length > 200) throw new PortalError("That password is too long.");
}

export async function findUser(ctx: PortalContext, email: string): Promise<PortalUser | null> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, password_hash, active, must_change_password FROM users WHERE email = ?`,
    )
    .get(email.trim().toLowerCase())) as UserRow | undefined;
  return row ? mapUser(row) : null;
}

function windowStart(ctx: PortalContext): string {
  return new Date(ctx.now().getTime() - LOGIN_WINDOW_MS).toISOString();
}

async function failureCount(ctx: PortalContext, column: "email" | "ip", value: string): Promise<number> {
  const row = await ctx.db
    .prepare(`SELECT COUNT(*) AS n FROM login_attempts WHERE ${column} = ? AND created_at >= ?`)
    .get(value, windowStart(ctx));
  return Number(row?.n ?? 0);
}

async function lockedOut(ctx: PortalContext, email: string, ip: string): Promise<boolean> {
  const [byEmail, byIp] = await Promise.all([
    failureCount(ctx, "email", email),
    failureCount(ctx, "ip", ip),
  ]);
  return byEmail >= LOGIN_FAILURE_LIMIT || byIp >= LOGIN_IP_FAILURE_LIMIT;
}

async function recordFailure(ctx: PortalContext, email: string, ip: string): Promise<void> {
  const cutoff = windowStart(ctx);
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE created_at < ?`).run(cutoff);
  await ctx.db
    .prepare(`INSERT INTO login_attempts (id, email, ip, created_at) VALUES (?, ?, ?, ?)`)
    .run(randomUUID(), email, ip, ctx.now().toISOString());
}

async function clearFailures(ctx: PortalContext, email: string): Promise<void> {
  await ctx.db.prepare(`DELETE FROM login_attempts WHERE email = ?`).run(email);
}

export async function loginWithPassword(
  ctx: PortalContext,
  email: string,
  password: string,
  ip: string,
): Promise<PasswordLoginResult> {
  const normalized = email.trim().toLowerCase();
  const address = ip.trim().slice(0, 80) || "unknown";
  if (await lockedOut(ctx, normalized, address)) {
    return { ok: false, status: 429, error: LOCKOUT_MESSAGE };
  }
  const user = await findUser(ctx, normalized);
  const ok = bcrypt.compareSync(password, user?.passwordHash || dummy());
  if (!user?.passwordHash || !ok) {
    await recordFailure(ctx, normalized, address);
    if (await lockedOut(ctx, normalized, address)) {
      return { ok: false, status: 429, error: LOCKOUT_MESSAGE };
    }
    return { ok: false, status: 401, error: "Invalid email or password" };
  }
  if (!user.active) {
    return { ok: false, status: 403, error: "This account is deactivated. Contact Select." };
  }
  await clearFailures(ctx, normalized);
  return {
    ok: true,
    session: { userId: user.id, email: user.email, name: user.name, role: user.role },
    mustChangePassword: user.mustChangePassword,
  };
}

export async function changeOwnPassword(
  ctx: PortalContext,
  session: Session,
  currentPassword: string,
  newPassword: string,
): Promise<void> {
  const user = await findUser(ctx, session.email);
  if (!user?.active || user.role !== session.role) throw new PortalError("Unauthorized", 401);
  if (!user.passwordHash) {
    throw new PortalError("This account signs in with Google and does not have a portal password.");
  }
  if (!bcrypt.compareSync(currentPassword, user.passwordHash)) {
    throw new PortalError("Current password is incorrect.");
  }
  assertPasswordStrength(newPassword);
  if (newPassword === currentPassword) throw new PortalError("Choose a different password.");
  await ctx.db
    .prepare(`UPDATE users SET password_hash = ?, must_change_password = 0 WHERE id = ?`)
    .run(hashPassword(newPassword), user.id);
}

export async function upsertExternalUser(
  ctx: PortalContext,
  input: { email: string; name: string; role: PortalRole },
): Promise<Session> {
  const email = input.email.trim().toLowerCase();
  const existing = await findUser(ctx, email);
  if (existing && !existing.active) throw new PortalError("This account is deactivated.", 403);
  if (existing) {
    await ctx.db.prepare(`UPDATE users SET name = ?, role = ? WHERE id = ?`).run(input.name || existing.name, input.role, existing.id);
    return { userId: existing.id, email, name: input.name || existing.name, role: input.role };
  }
  const id = randomUUID();
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at)
       VALUES (?, ?, ?, ?, NULL, 1, 0, ?)`,
    )
    .run(id, email, input.name || email, input.role, new Date().toISOString());
  return { userId: id, email, name: input.name || email, role: input.role };
}
