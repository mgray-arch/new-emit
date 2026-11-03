import { findRateField } from "@/lib/carrier-notice";
import { applyLoadStatus, consumeLoadBuilderCallback, loadBuilderSecretMatches } from "@/lib/load-builder";
import { errorResponse, json, PortalError } from "@/lib/http";
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
  carrierName: z.string().trim().max(160).optional(),
  carrier_name: z.string().trim().max(160).optional(),
  mcNumber: z.string().trim().max(40).optional(),
  mc_number: z.string().trim().max(40).optional(),
  mc: z.string().trim().max(40).optional(),
});

export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const limit = await consumeLoadBuilderCallback(ctx, clientIp(req));
    if (!limit.allowed) {
      return json({ error: "Too many requests. Try again shortly." }, 429, { "retry-after": String(limit.retryAfterSeconds) });
    }
    if (!loadBuilderSecretMatches(req)) return json({ error: "Unauthorized" }, 401);
    const raw = await req.json();
    if (findRateField(raw)) {
      throw new PortalError("This endpoint does not accept rate, pay, or rate confirmation fields.");
    }
    const body = bodySchema.parse(raw);
    const salesOrderNumber = body.salesOrderNumber ?? body.sales_order_number;
    const loadNumber = body.loadNumber ?? body.load_number;
    const nameProvided = body.carrierName !== undefined || body.carrier_name !== undefined;
    const mcProvided = body.mcNumber !== undefined || body.mc_number !== undefined || body.mc !== undefined;
    if (!body.orderId && !salesOrderNumber) {
      throw new PortalError("Send orderId or salesOrderNumber with the SAM load number.");
    }
    if (!loadNumber && !nameProvided && !mcProvided) {
      throw new PortalError("Send a SAM load number, a carrier name, or an MC number.");
    }
    const result = await applyLoadStatus(ctx, {
      orderId: body.orderId,
      salesOrderNumber,
      loadNumber,
      carrier:
        nameProvided || mcProvided
          ? {
              name: body.carrierName ?? body.carrier_name,
              mc: body.mcNumber ?? body.mc_number ?? body.mc,
              nameProvided,
              mcProvided,
            }
          : null,
    });
    const payload: Record<string, string | null> = {
      orderId: result.order.id,
      salesOrderNumber: result.order.salesOrderNumber,
      loadNumber: result.order.loadNumber,
    };
    if (result.notice) payload.notice = result.notice;
    return json(payload);
  } catch (error) {
    return errorResponse(error);
  }
}
