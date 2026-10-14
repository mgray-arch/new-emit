import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { getOrder, updateOrder } from "@/lib/orders";
import { latestConfirmation } from "@/lib/email";
import { readyPortal } from "@/lib/portal";
import { orderPatchSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const order = await getOrder(ctx, id);
    if (!order) return json({ error: "Order not found" }, 404);
    return json({ order, confirmation: await latestConfirmation(ctx, id) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const patch = orderPatchSchema.parse(await req.json());
    const order = await updateOrder(ctx, id, patch, session);
    return json({ order });
  } catch (error) {
    return errorResponse(error);
  }
}
