import { forbidden, json, unauthorized } from "@/lib/http";
import { assertSessionLive } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { readSession, sameOrigin } from "@/lib/session";
import type { Session } from "@/lib/types";

export async function requireSession(req: Request): Promise<Session | Response> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return json({ error: "Cross-origin request blocked" }, 403);
  }
  const session = await readSession(req);
  if (!session) return unauthorized();
  const live = await assertSessionLive(await readyPortal(), session);
  if (!live) return unauthorized();
  return live;
}

export async function requireAdmin(req: Request): Promise<Session | Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  if (session.role !== "admin") return forbidden();
  return session;
}

/** Saved delivery locations. EMIT admins can manage drops. They cannot edit EMIT pickup sites. */
export async function requireLocationEditor(req: Request): Promise<Session | Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  if (session.role !== "admin" && session.role !== "emit_admin") return forbidden();
  return session;
}

export function isSession(value: Session | Response): value is Session {
  return !(value instanceof Response);
}
