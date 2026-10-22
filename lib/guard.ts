import { forbidden, json, unauthorized } from "@/lib/http";
import { assertSessionLive } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { VIEW_AS_COOKIE, cookieValue, parseViewAs, readSession, sameOrigin } from "@/lib/session";
import { canManageLocations, type PortalRole, type Session } from "@/lib/types";

function viewAsPreview(req: Request) {
  return parseViewAs(cookieValue(req, VIEW_AS_COOKIE));
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
  const viewAs = actor.role === "admin" ? viewAsPreview(req) : null;
  if (!viewAs) return { ...actor, actorRole: actor.role, viewAs: null };
  const role: PortalRole = viewAs.access === "admin" ? "emit_admin" : "customer";
  return { ...actor, role, permission: viewAs.permission, actorRole: "admin", viewAs };
}

/** Select view-as can look. It cannot create, edit, upload, or change a password. */
export function rejectIfViewingAs(session: Session): Response | null {
  if (!session.viewAs) return null;
  return json({ error: "View-as is read-only. Switch back to Select view to change anything." }, 403);
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

/** Saved delivery locations. EMIT admins can open the list. View only cannot, and a regular user cannot. */
export async function requireLocationReader(req: Request): Promise<Session | Response> {
  const session = await requireSession(req);
  if (session instanceof Response) return session;
  if (session.role !== "admin" && session.role !== "emit_admin") return forbidden();
  return session;
}

/** Writes. View-as is rejected even when the previewed role could edit. */
export async function requireLocationEditor(req: Request): Promise<Session | Response> {
  const session = await requireLocationReader(req);
  if (session instanceof Response) return session;
  const readonly = rejectIfViewingAs(session);
  if (readonly) return readonly;
  if (!canManageLocations(session)) return forbidden();
  return session;
}

export function isSession(value: Session | Response): value is Session {
  return !(value instanceof Response);
}
