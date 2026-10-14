import { forbidden, json, unauthorized } from "@/lib/http";
import { readSession, sameOrigin } from "@/lib/session";
import type { Session } from "@/lib/types";

export async function requireSession(req: Request): Promise<Session | Response> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return json({ error: "Cross-origin request blocked" }, 403);
  }
  const session = await readSession(req);
  if (!session) return unauthorized();
  return session;
}

export async function requireAdmin(req: Request): Promise<Session | Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  if (session.role !== "admin") return forbidden();
  return session;
}

export function isSession(value: Session | Response): value is Session {
  return !(value instanceof Response);
}
