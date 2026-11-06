import { badgeForOrder, latestNotice, markCarrierSeen, seenMap } from "@/lib/carrier-seen";
import { countBolPrints } from "@/lib/bol-print";
import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { getOrder, updateOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { latestTrackingAt, trackingIsUnseen } from "@/lib/tracking-link";
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
    const seen = await seenMap(ctx, session.userId);
    const carrierBadge = badgeForOrder(order, seen);
    const trackingAt = latestTrackingAt(order.trackingEvents);
    const trackingBadge = trackingIsUnseen(trackingAt, seen.get(order.id));
    const latest = latestNotice(order.notices);
    const seenAt = [latest?.at, trackingAt].filter((value): value is string => Boolean(value)).sort().at(-1);
    if (seenAt) await markCarrierSeen(ctx, session.userId, order.id, seenAt);
    const presented = presentCustomerOrder(order, session, { carrierBadge, trackingBadge });
    presented.bolPrintCount = await countBolPrints(ctx, order.id);
    return json({ order: presented });
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
    const result = await updateOrder(ctx, id, patch, session);
    return json({ order: presentCustomerOrder(result.order, session), warnings: result.warnings });
  } catch (error) {
    return errorResponse(error);
  }
}
