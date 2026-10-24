import { acceptBuiltLoadNumber, consumeLoadBuilderCallback, loadBuilderSecretMatches } from "@/lib/load-builder";
import { errorResponse, json, PortalError } from "@/lib/http";
import { clientIp } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  orderId: z.string().trim().max(80).optional(),
  salesOrderNumber: z.string().trim().max(120).optional(),
  loadNumber: z.string().trim().min(1).max(40),
});

export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const limit = await consumeLoadBuilderCallback(ctx, clientIp(req));
    if (!limit.allowed) {
      return json({ error: "Too many requests. Try again shortly." }, 429, { "retry-after": String(limit.retryAfterSeconds) });
    }
    if (!loadBuilderSecretMatches(req)) return json({ error: "Unauthorized" }, 401);
    const body = bodySchema.parse(await req.json());
    if (!body.orderId && !body.salesOrderNumber) {
      throw new PortalError("Send orderId or salesOrderNumber with the SAM load number.");
    }
    const order = await acceptBuiltLoadNumber(ctx, body);
    return json({
      orderId: order.id,
      salesOrderNumber: order.salesOrderNumber,
      loadNumber: order.loadNumber,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
