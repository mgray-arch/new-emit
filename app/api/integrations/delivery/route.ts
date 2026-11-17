import { findRateField } from "@/lib/carrier-notice";
import { DELIVERY_EVENTS, recordDeliverySignal, type DeliveryEvent } from "@/lib/delivery";
import { errorResponse, json, PortalError } from "@/lib/http";
import { consumeLoadBuilderCallback, loadBuilderSecretMatches } from "@/lib/load-builder";
import { clientIp } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  orderId: z.string().trim().max(80).optional(),
  salesOrderNumber: z.string().trim().max(120).optional(),
  sales_order_number: z.string().trim().max(120).optional(),
  loadNumber: z.string().trim().max(40).optional(),
  load_number: z.string().trim().max(40).optional(),
  event: z.enum(DELIVERY_EVENTS),
});

/**
 * Record a delivery event for the morning job.
 * Auth matches the load-status callback: bearer `LOAD_BUILDER_SECRET` or `LOAD_STATUS_WEBHOOK_SECRET`.
 * A position, a tracking link, or a ping does not belong here and does not move the load to In Transit.
 * The portal status stays put until 5:00 AM America/Boise, or until someone marks the load delivered.
 */
export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const limit = await consumeLoadBuilderCallback(ctx, clientIp(req));
    if (!limit.allowed) {
      return json({ error: "Too many requests. Try again shortly." }, 429, { "retry-after": String(limit.retryAfterSeconds) });
    }
    if (!loadBuilderSecretMatches(req)) return json({ error: "Unauthorized" }, 401);
    const type = req.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) throw new PortalError("Send JSON.", 415);
    const raw = await req.json();
    if (findRateField(raw)) {
      throw new PortalError("This endpoint does not accept rate, pay, or rate confirmation fields.");
    }
    const body = bodySchema.parse(raw);
    const salesOrderNumber = body.salesOrderNumber ?? body.sales_order_number;
    const loadNumber = body.loadNumber ?? body.load_number;
    if (!body.orderId && !salesOrderNumber && !loadNumber) {
      throw new PortalError("Send orderId, salesOrderNumber, or loadNumber.");
    }
    const result = await recordDeliverySignal(ctx, {
      orderId: body.orderId,
      salesOrderNumber,
      loadNumber,
      event: body.event as DeliveryEvent,
    });
    return json({
      orderId: result.orderId,
      portalStatus: result.portalStatus,
      event: result.event,
      recorded: true,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
