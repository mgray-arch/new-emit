import { randomUUID } from "node:crypto";
import { canProvisionEmitUser } from "@/lib/auth-policy";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import { findUser, findUserById, generateTemporaryPassword, hashPassword, setPasswordHash, type UserRow } from "@/lib/passwords";
import {
  accessFromRole,
  isEmitPermission,
  isEmitProfile,
  permissionFromRole,
  type EmitAccess,
  type EmitPermission,
  type EmitProfile,
  type PortalRole,
} from "@/lib/types";

export interface EmitUser {
  id: string;
  email: string;
  name: string;
  active: boolean;
  /** EMIT admin or regular user. Separate from the load permission. */
  access: EmitAccess;
  permission: EmitPermission;
  /** True when access is admin. Kept so older clients still read the flag. */
  emitAdmin: boolean;
  /** Messages. Off until Select checks it. Select staff are not on this list. */
  chatEnabled: boolean;
  /** Sales or Loader. Null is a standard EMIT user. */
  profile: EmitProfile | null;
  hasPassword: boolean;
  createdAt: string;
}

function isEmitRole(role: string): boolean {
  return role === "customer" || role === "emit_viewer" || role === "emit_admin";
}

function toEmitUser(row: UserRow & { created_at?: string }, createdAt: string): EmitUser {
  const permission = isEmitPermission(row.permission) ? row.permission : (permissionFromRole(row.role) ?? "add");
  const access = accessFromRole(row.role);
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    active: Number(row.active) !== 0,
    access,
    permission,
    emitAdmin: access === "admin",
    chatEnabled: Number(row.chat_enabled) === 1,
    profile: isEmitProfile(row.profile) ? row.profile : null,
    hasPassword: Boolean(row.password_hash),
    createdAt,
  };
}

/** Select staff always have Messages. An EMIT user needs the checkbox on their row. */
export async function chatEnabledFor(ctx: PortalContext, session: { userId: string; role: string; actorRole?: string | null }): Promise<boolean> {
  if ((session.actorRole ?? session.role) === "admin" || session.role === "admin") return true;
  const user = await findUserById(ctx, session.userId);
  if (!user || user.role === "admin") return user?.role === "admin";
  return Number(user.chat_enabled) === 1;
}

function roleForAccess(access: EmitAccess): PortalRole {
  return access === "admin" ? "emit_admin" : "customer";
}

/** Sales and Loader can view, upload, and print. They cannot add loads or see cost. */
export function assertProfilePermission(profile: EmitProfile | null, permission: EmitPermission): void {
  if ((profile === "sales" || profile === "loader") && permission !== "view") {
    const name = profile === "sales" ? "Sales" : "Loader";
    throw new PortalError(`${name} can view, upload, and print only. They cannot add loads or see pricing.`, 400);
  }
}

export async function listEmitUsers(ctx: PortalContext): Promise<EmitUser[]> {
  const rows = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, permission, profile, password_hash, active, password_changed_at, password_epoch, chat_enabled, created_at
       FROM users WHERE role IN ('customer', 'emit_viewer', 'emit_admin') ORDER BY name COLLATE NOCASE, email`,
    )
    .all()) as unknown as Array<UserRow & { created_at: string }>;
  return rows.map((row) => toEmitUser(row, row.created_at));
}

async function requireEmitUser(ctx: PortalContext, id: string): Promise<UserRow & { created_at: string }> {
  const row = (await ctx.db
    .prepare(
      `SELECT id, email, name, role, permission, profile, password_hash, active, password_changed_at, password_epoch, chat_enabled, created_at FROM users WHERE id = ?`,
    )
    .get(id)) as (UserRow & { created_at: string }) | undefined;
  if (!row || !isEmitRole(row.role)) throw new PortalError("EMIT user not found", 404);
  return row;
}

export async function createEmitUser(
  ctx: PortalContext,
  input: {
    name: string;
    email: string;
    password?: string;
    generatePassword?: boolean;
    access?: EmitAccess;
    permission?: EmitPermission;
    chatEnabled?: boolean;
    profile?: EmitProfile | null;
  },
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
  const profile = isEmitProfile(input.profile) ? input.profile : null;
  const permission = input.permission ?? (profile === "loader" || profile === "sales" ? "view" : "add");
  assertProfilePermission(profile, permission);
  const access = input.access ?? (permission === "full" ? "admin" : "regular");
  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  const chatEnabled = input.chatEnabled === true ? 1 : 0;
  await ctx.db
    .prepare(
      `INSERT INTO users (id, email, name, role, permission, profile, password_hash, active, password_changed_at, password_epoch, chat_enabled, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, 1, ?, ?)`,
    )
    .run(id, decision.email, name, roleForAccess(access), permission, profile, hashPassword(password), createdAt, chatEnabled, createdAt);
  const created = await findUserById(ctx, id);
  if (!created) throw new PortalError("The user could not be saved", 500);
  return { user: toEmitUser(created, createdAt), temporaryPassword };
}

export async function updateEmitUser(
  ctx: PortalContext,
  id: string,
  patch: {
    name?: string;
    active?: boolean;
    emitAdmin?: boolean;
    access?: EmitAccess;
    permission?: EmitPermission;
    chatEnabled?: boolean;
    profile?: EmitProfile | null;
  },
): Promise<EmitUser> {
  const existing = await requireEmitUser(ctx, id);
  const name = patch.name === undefined ? existing.name : patch.name.trim();
  if (!name || name.length > 80) throw new PortalError("Enter the person's name.");
  const active = patch.active === undefined ? Number(existing.active) : patch.active ? 1 : 0;
  let access = accessFromRole(existing.role);
  if (patch.access) access = patch.access;
  if (patch.emitAdmin === true) access = "admin";
  if (patch.emitAdmin === false) access = "regular";
  const currentPermission = isEmitPermission(existing.permission) ? existing.permission : (permissionFromRole(existing.role) ?? "add");
  const permission = patch.permission ?? currentPermission;
  const profile = patch.profile === undefined ? (isEmitProfile(existing.profile) ? existing.profile : null) : isEmitProfile(patch.profile) ? patch.profile : null;
  assertProfilePermission(profile, permission);
  const chatEnabled = patch.chatEnabled === undefined ? (Number(existing.chat_enabled) === 1 ? 1 : 0) : patch.chatEnabled ? 1 : 0;
  await ctx.db
    .prepare(`UPDATE users SET name = ?, active = ?, role = ?, permission = ?, profile = ?, chat_enabled = ? WHERE id = ?`)
    .run(name, active, roleForAccess(access), permission, profile, chatEnabled, id);
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
