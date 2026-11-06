import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { copyDraft } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { canAddLoads } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Prefills a new load. Nothing is saved until the user submits the form. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    if (!canAddLoads(session)) throw new PortalError("This account can view loads but cannot add them.", 403);
    const { id } = await context.params;
    const draft = await copyDraft(await readyPortal(), id);
    return json({ draft });
  } catch (error) {
    return errorResponse(error);
  }
}
