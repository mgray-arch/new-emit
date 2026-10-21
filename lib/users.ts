import { randomUUID } from "node:crypto";
import { canProvisionEmitUser } from "@/lib/auth-policy";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { findUser, findUserById, generateTemporaryPassword, hashPassword, setPasswordHash, type UserRow } from "@/lib/passwords";

export interface EmitUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
  emitAdmin: boolean;
  hasPassword: boolean;
  createdAt: string;
}

function isEmitRole(role: string): boolean {
  return role === "customer" || role === "emit_admin";
}

function toEmitUser(row: UserRow & { created_at?: string }, createdAt: string): EmitUser {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    active: Number(row.active) !== 0,
    emitAdmin: row.role === "emit_admin",
    hasPassword: Boolean(row.password_hash),
    createdAt,
  };
}

export async function listEmitUsers(ctx: PortalContext): Promise<EmitUser[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, password_hash, active, password_changed_at, password_epoch, created_at
       FROM users WHERE role IN ('customer', 'emit_admin') ORDER BY name COLLATE NOCASE, email`,
    )
    .all()) as unknown as Array<UserRow & { created_at: string }>;
  return rows.map((row) => toEmitUser(row, row.created_at));
}

async function requireEmitUser(ctx: PortalContext, id: string): Promise<UserRow & { created_at: string }> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, password_hash, active, password_changed_at, password_epoch, created_at FROM users WHERE id = ?`,
    )
    .get(id)) as (UserRow & { created_at: string }) | undefined;
  if (!row || !isEmitRole(row.role)) throw new PortalError("EMIT user not found", 404);
  return row;
}

export async function createEmitUser(
  ctx: PortalContext,
  input: { name: string; email: string; password?: string; generatePassword?: boolean },
): Promise<{ user: EmitUser; temporaryPassword?: string }> {
  const decision = canProvisionEmitUser(input.email);
  if (!decision.ok) throw new PortalError(decision.error);
  const name = input.name.trim();
  if (!name || name.length > 80) throw new PortalError("Enter the person's name.");
  const existing = await findUser(ctx, decision.email);
  if (existing) throw new PortalError("That email is already a portal user.");
  let temporaryPassword: string | undefined;
  let password = input.password?.trim() ?? "";
  if (input.generatePassword) {
    temporaryPassword = generateTemporaryPassword();
    password = temporaryPassword;
  } else if (!password) {
    throw new PortalError("Set a temporary password or generate one.");
  }
  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, password_hash, active, password_changed_at, password_epoch, created_at)
       VALUES (?, ?, ?, 'customer', ?, 1, ?, 1, ?)`,
    )
    .run(id, decision.email, name, hashPassword(password), createdAt, createdAt);
  const created = await findUserById(ctx, id);
  if (!created) throw new PortalError("The user could not be saved", 500);
  return { user: toEmitUser(created, createdAt), temporaryPassword };
}

export async function updateEmitUser(
  ctx: PortalContext,
  id: string,
  patch: { name?: string; active?: boolean; emitAdmin?: boolean },
): Promise<EmitUser> {
  const existing = await requireEmitUser(ctx, id);
  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name || name.length > 80) throw new PortalError("Enter the person's name.");
  const active = patch.active === undefined ? Number(existing.active) : patch.active ? 1 : 0;
  const role = patch.emitAdmin === undefined ? existing.role : patch.emitAdmin ? "emit_admin" : "customer";
  await ctx.db.prepare(`UPDATE users SET name = ?, active = ?, role = ? WHERE id = ?`).run(name, active, role, id);
  const updated = await requireEmitUser(ctx, id);
  return toEmitUser(updated, updated.created_at);
}

export async function resetEmitPassword(
  ctx: PortalContext,
  id: string,
  input: { password?: string; generatePassword?: boolean },
): Promise<{ user: EmitUser; temporaryPassword?: string }> {
  const existing = await requireEmitUser(ctx, id);
  let temporaryPassword: string | undefined;
  let password = input.password?.trim() ?? "";
  if (input.generatePassword) {
    temporaryPassword = generateTemporaryPassword();
    password = temporaryPassword;
  } else if (!password) {
    throw new PortalError("Set a temporary password or generate one.");
  }
  await setPasswordHash(ctx, existing.id, password);
  const updated = await requireEmitUser(ctx, id);
  return { user: toEmitUser(updated, updated.created_at), temporaryPassword };
}
