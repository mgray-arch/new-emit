import { randomUUID } from "node:crypto";
import { adminEmails, selectDomain } from "@/lib/auth-policy";
import type { PortalContext } from "@/lib/db";
import { PortalError } from "@/lib/http";
import {
  assertPasswordStrength,
  findUser,
  generateTemporaryPassword,
  hashPassword,
  type PortalUser,
} from "@/lib/passwords";

export interface EmitUserAccount {
  id: string;
  email: string;
  name: string;
  active: boolean;
  mustChangePassword: boolean;
  createdAt: string;
}

function toAccount(user: PortalUser, createdAt: string): EmitUserAccount {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    active: user.active,
    mustChangePassword: user.mustChangePassword,
    createdAt,
  };
}

function assertEmitEmail(email: string): void {
  if (adminEmails().includes(email) || email.endsWith(`@${selectDomain()}`)) {
    throw new PortalError("Select staff sign in with Google. This page is for EMIT users.");
  }
}

async function requireEmitUser(ctx: PortalContext, id: string): Promise<PortalUser> {
  const row = (await ctx.db
    .prepare(`SELECT id, email, name, role, password_hash, active, must_change_password FROM users WHERE id = ?`)
    .get(id)) as
    | {
        id: string;
        email: string;
        name: string;
        role: "customer" | "admin";
        password_hash: string | null;
        active: number | null;
        must_change_password: number | null;
      }
    | undefined;
  if (!row || row.role !== "customer") throw new PortalError("EMIT user not found", 404);
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

export async function listEmitUsers(ctx: PortalContext): Promise<EmitUserAccount[]> {
  const rows = await ctx.db
    .prepare(
      `SELECT id, email, name, active, must_change_password, created_at
       FROM users WHERE role = 'customer' ORDER BY name COLLATE NOCASE, email`,
    )
    .all();
  return rows.map((row) => ({
    id: String(row.id),
    email: String(row.email),
    name: String(row.name),
    active: Number(row.active ?? 1) !== 0,
    mustChangePassword: Number(row.must_change_password ?? 0) !== 0,
    createdAt: String(row.created_at),
  }));
}

export async function createEmitUser(
  ctx: PortalContext,
  input: { name: string; email: string; password?: string | null; generatePassword?: boolean },
): Promise<{ user: EmitUserAccount; temporaryPassword: string }> {
  const email = input.email.trim().toLowerCase();
  const name = input.name.trim();
  if (!name) throw new PortalError("Name is required.");
  assertEmitEmail(email);
  if (await findUser(ctx, email)) throw new PortalError("A user with that email already exists.", 409);
  const generated = input.generatePassword || !input.password;
  const temporaryPassword = generated ? generateTemporaryPassword() : input.password!;
  if (!generated) assertPasswordStrength(temporaryPassword);
  const id = randomUUID();
  const createdAt = ctx.now().toISOString();
  try {
    await ctx.db
      .prepare(
        `INSERT INTO users (id, email, name, role, password_hash, active, must_change_password, created_at)
         VALUES (?, ?, ?, 'customer', ?, 1, 1, ?)`,
      )
      .run(id, email, name, hashPassword(temporaryPassword), createdAt);
  } catch (error) {
    if (String(error).includes("UNIQUE")) throw new PortalError("A user with that email already exists.", 409);
    throw error;
  }
  const user = await requireEmitUser(ctx, id);
  return { user: toAccount(user, createdAt), temporaryPassword };
}

export async function updateEmitUser(
  ctx: PortalContext,
  id: string,
  patch: { name?: string; active?: boolean; password?: string | null; generatePassword?: boolean },
): Promise<{ user: EmitUserAccount; temporaryPassword: string | null }> {
  const existing = await requireEmitUser(ctx, id);
  const name = patch.name?.trim() || existing.name;
  const active = patch.active ?? existing.active;
  let temporaryPassword: string | null = null;
  let passwordHash: string | null = null;
  let mustChange = existing.mustChangePassword;
  if (patch.generatePassword) {
    temporaryPassword = generateTemporaryPassword();
    passwordHash = hashPassword(temporaryPassword);
    mustChange = true;
  } else if (patch.password) {
    assertPasswordStrength(patch.password);
    temporaryPassword = patch.password;
    passwordHash = hashPassword(patch.password);
    mustChange = true;
  }
  if (passwordHash) {
    await ctx.db
      .prepare(
        `UPDATE users SET name = ?, active = ?, password_hash = ?, must_change_password = ? WHERE id = ?`,
      )
      .run(name, active ? 1 : 0, passwordHash, mustChange ? 1 : 0, id);
  } else {
    await ctx.db.prepare(`UPDATE users SET name = ?, active = ? WHERE id = ?`).run(name, active ? 1 : 0, id);
  }
  const user = await requireEmitUser(ctx, id);
  const created = await ctx.db.prepare(`SELECT created_at FROM users WHERE id = ?`).get(id);
  return { user: toAccount(user, String(created?.created_at ?? "")), temporaryPassword };
}
