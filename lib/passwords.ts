import bcrypt from "bcryptjs";
import { randomUUID } from "node:crypto";
import type { PortalContext } from "@/lib/db";
import type { Session } from "@/lib/types";

let dummyHash: string | null = null;

function dummy(): string {
  dummyHash ??= bcrypt.hashSync("not-a-real-password", 8);
  return dummyHash;
}

interface UserRow {
  id: string;
  email: string;
  name: string;
  role: "customer" | "admin";
  password_hash: string | null;
}

export function findUser(ctx: PortalContext, email: string): UserRow | null {
  const row = ctx.db.prepare(`SELECT id, email, name, role, password_hash FROM users WHERE email = ?`).get(
    email.trim().toLowerCase(),
  ) as UserRow | undefined;
  return row ?? null;
}

export function loginWithPassword(ctx: PortalContext, email: string, password: string): Session | null {
  const user = findUser(ctx, email);
  const ok = bcrypt.compareSync(password, user?.password_hash || dummy());
  if (!user?.password_hash || !ok) return null;
  return { userId: user.id, email: user.email, name: user.name, role: user.role };
}

export function upsertExternalUser(ctx: PortalContext, input: { email: string; name: string; role: "customer" | "admin" }): Session {
  const email = input.email.trim().toLowerCase();
  const existing = findUser(ctx, email);
  if (existing) {
    ctx.db.prepare(`UPDATE users SET name = ?, role = ? WHERE id = ?`).run(input.name || existing.name, input.role, existing.id);
    return { userId: existing.id, email, name: input.name || existing.name, role: input.role };
  }
  const id = randomUUID();
  ctx.db
    .prepare(`INSERT INTO users (id, email, name, role, password_hash, created_at) VALUES (?, ?, ?, ?, NULL, ?)`)
    .run(id, email, input.name || email, input.role, new Date().toISOString());
  return { userId: id, email, name: input.name || email, role: input.role };
}
