import { isSession, rejectIfViewingAs, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { deleteOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function DELETE(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    const { id } = await context.params;
    await deleteOrder(await readyPortal(), id, { name: session.name, email: session.email });
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
