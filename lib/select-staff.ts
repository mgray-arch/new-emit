import { randomUUID, timingSafeEqual } from "node:crypto";
import { adminEmails } from "@/lib/auth-policy";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import {
  findUser,
  findUserById,
  findUsersByEmail,
  generateTemporaryPassword,
  hashPassword,
  promoteToSelectAdmin,
  setPasswordHash,
  type UserRow,
} from "@/lib/passwords";

const MIN_KEY_LENGTH = 16;

export interface SelectStaff {
  id: string;
  email: string;
  name: string;
  active: boolean;
  hasPassword: boolean;
}

export function selectSetupKey(env: Record<string, string | undefined> = process.env): string | null {
  const key = env.SELECT_SETUP_KEY?.trim() ?? "";
  if (key.length < MIN_KEY_LENGTH) return null;
  return key;
}

export function selectSetupEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return selectSetupKey(env) !== null;
}

/** Constant-time check. A missing or short key never matches. */
export function setupKeyMatches(presented: string, env: Record<string, string | undefined> = process.env): boolean {
  const expected = selectSetupKey(env);
  const standIn = "x".repeat(MIN_KEY_LENGTH);
  const left = Buffer.from(presented.trim() || standIn);
  const right = Buffer.from(expected ?? standIn);
  if (!expected || left.length !== right.length) {
    timingSafeEqual(Buffer.from(standIn), Buffer.from(standIn));
    return false;
  }
  return timingSafeEqual(left, right);
}

export function isListedSelectAdmin(email: string): boolean {
  return adminEmails().includes(email.trim().toLowerCase());
}

function toStaff(row: UserRow): SelectStaff {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    active: Number(row.active) !== 0,
    hasPassword: Boolean(row.password_hash),
  };
}

export async function listSelectStaff(ctx: PortalContext): Promise<SelectStaff[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, permission, password_hash, active, password_changed_at, password_epoch, chat_enabled
       FROM users WHERE role = 'admin' ORDER BY name COLLATE NOCASE, email`,
    )
    .all()) as unknown as UserRow[];
  return rows.map(toStaff);
}

async function requireSelectStaff(ctx: PortalContext, id: string): Promise<UserRow> {
  const row = await findUserById(ctx, id);
  if (!row || row.role !== "admin") throw new PortalError("Select staff account not found", 404);
  return row;
}

function displayName(name: string | undefined, email: string): string {
  const trimmed = name?.trim() || email.split("@")[0] || email;
  if (!trimmed || trimmed.length > 80) throw new PortalError("Enter the person's name.");
  return trimmed;
}

/**
 * Create a Select admin. The email has to be on SELECT_ADMIN_EMAILS.
 * The password is stored as a hash. The plaintext is not written.
 */
export async function createSelectStaff(
  ctx: PortalContext,
  input: { name: string; email: string; password?: string; generatePassword?: boolean },
): Promise<{ user: SelectStaff; temporaryPassword?: string }> {
  const email = input.email.trim().toLowerCase();
  if (!email.includes("@")) throw new PortalError("Enter an email address.");
  if (!isListedSelectAdmin(email)) {
    throw new PortalError("That email is not on SELECT_ADMIN_EMAILS. Add it there before creating the account.");
  }
  const existing = await findUser(ctx, email);
  if (existing) throw new PortalError("That email is already a portal user.");
  const name = displayName(input.name, email);
  let temporaryPassword: string | undefined;
  let password = input.password?.trim() ?? "";
  if (input.generatePassword) {
    temporaryPassword = generateTemporaryPassword();
    password = temporaryPassword;
  } else if (!password) {
    throw new PortalError("Set a temporary password or generate one.");
  }
  const id = randomUUID();
  const now = ctx.now().toISOString();
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, permission, password_hash, active, password_changed_at, password_epoch, created_at)
       VALUES (?, ?, ?, 'admin', NULL, ?, 1, ?, 1, ?)`,
    )
    .run(id, email, name, hashPassword(password), now, now);
  const created = await findUserById(ctx, id);
  if (!created) throw new PortalError("The account could not be saved", 500);
  return { user: toStaff(created), temporaryPassword };
}

export async function resetSelectPassword(
  ctx: PortalContext,
  id: string,
  input: { password?: string; generatePassword?: boolean },
): Promise<{ user: SelectStaff; temporaryPassword?: string }> {
  const existing = await requireSelectStaff(ctx, id);
  let temporaryPassword: string | undefined;
  let password = input.password?.trim() ?? "";
  if (input.generatePassword) {
    temporaryPassword = generateTemporaryPassword();
    password = temporaryPassword;
  } else if (!password) {
    throw new PortalError("Set a temporary password or generate one.");
  }
  await setPasswordHash(ctx, existing.id, password);
  const updated = await requireSelectStaff(ctx, id);
  return { user: toStaff(updated), temporaryPassword };
}

export async function setSelectStaffActive(ctx: PortalContext, id: string, active: boolean, actorId: string): Promise<SelectStaff> {
  const existing = await requireSelectStaff(ctx, id);
  if (!active && existing.id === actorId) throw new PortalError("You cannot deactivate your own account.");
  await ctx.db.prepare(`UPDATE users SET active = ? WHERE id = ?`).run(active ? 1 : 0, id);
  const updated = await requireSelectStaff(ctx, id);
  return toStaff(updated);
}

/**
 * First Select password, or a replacement, while SELECT_SETUP_KEY is set.
 * Refuses an EMIT account. Does not return the password.
 */
export async function claimSelectPassword(
  ctx: PortalContext,
  input: { email: string; password: string; name?: string },
): Promise<{ email: string; created: boolean }> {
  const email = input.email.trim().toLowerCase();
  if (!isListedSelectAdmin(email)) {
    throw new PortalError("That email is not on SELECT_ADMIN_EMAILS. Add it there before setting a password.");
  }
  const matches = await findUsersByEmail(ctx, email);
  const existing = matches.find((row) => row.role === "admin") ?? matches[0] ?? null;
  if (!existing) {
    const created = await createSelectStaff(ctx, { name: displayName(input.name, email), email, password: input.password });
    return { email: created.user.email, created: true };
  }
  if (existing.role !== "admin") await promoteToSelectAdmin(ctx, existing.id);
  if (existing.email !== email) {
    const clash = await ctx.db.prepare(`SELECT id FROM users WHERE email = ? AND id <> ?`).get(email, existing.id);
    if (!clash) await ctx.db.prepare(`UPDATE users SET email = ? WHERE id = ?`).run(email, existing.id);
  }
  if (input.name?.trim()) {
    const name = displayName(input.name, email);
    await ctx.db.prepare(`UPDATE users SET name = ? WHERE id = ?`).run(name, existing.id);
  }
  await setPasswordHash(ctx, existing.id, input.password);
  return { email, created: false };
}
