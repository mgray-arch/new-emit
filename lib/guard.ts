import { forbidden, json, unauthorized } from "@/lib/http";
import { assertSessionLive } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { VIEW_AS_COOKIE, cookieValue, readSession, sameOrigin } from "@/lib/session";
import type { PortalRole, Session } from "@/lib/types";

const VIEW_AS_ROLES: PortalRole[] = ["emit_admin", "customer", "emit_viewer"];

function viewAsRole(req: Request): PortalRole | null {
  const value = cookieValue(req, VIEW_AS_COOKIE);
  return VIEW_AS_ROLES.find((role) => role === value) ?? null;
}

/** The signed-in person, before a Select view-as preview is applied. */
export async function requireActor(req: Request): Promise<Session | Response> {
  if (req.method !== "GET" && req.method !== "HEAD" && !sameOrigin(req)) {
    return json({ error: "Cross-origin request blocked" }, 403);
  }
  const session = await readSession(req);
  if (!session) return unauthorized();
  const live = await assertSessionLive(await readyPortal(), session);
  if (!live) return unauthorized();
  return live;
}

/**
 * The role whose data rules apply. A Select admin's view-as cookie narrows this
 * to an EMIT role. An EMIT cookie cannot widen their own role.
 */
export async function requireSession(req: Request): Promise<Session | Response> {
  const actor = await requireActor(req);
  if (actor instanceof Response) return actor;
  const viewAs = actor.role === "admin" ? viewAsRole(req) : null;
  if (!viewAs) return { ...actor, actorRole: actor.role, viewAs: null };
  return { ...actor, role: viewAs, actorRole: "admin", viewAs };
}

export async function requireAdmin(req: Request): Promise<Session | Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  if (session.role !== "admin") return forbidden();
  return session;
}

/** Select tools that must ignore view-as, such as leaving the preview. */
export async function requireActorAdmin(req: Request): Promise<Session | Response> {
  const actor = await requireActor(req);
  if (actor instanceof Response) return actor;
  if (actor.role !== "admin") return forbidden();
  return actor;
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
