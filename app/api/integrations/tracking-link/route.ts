import { botKeyMatches, consumeBotUpload, ingestBotTrackingLink } from "@/lib/bot-documents";
import { errorResponse, json, PortalError, unauthorized } from "@/lib/http";
import { clientIp } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  loadNumber: z.string().max(40).optional(),
  load_number: z.string().max(40).optional(),
  salesOrderNumber: z.string().max(80).optional(),
  sales_order_number: z.string().max(80).optional(),
  trackingLink: z.string().max(2000).optional(),
  tracking_link: z.string().max(2000).optional(),
});

export async function POST(req: Request) {
  try {
    const ctx = await readyPortal();
    const budget = await consumeBotUpload(ctx, clientIp(req));
    if (!budget.allowed) {
      return json({ error: "Too many requests. Try again shortly." }, 429, {
        "retry-after": String(budget.retryAfterSeconds),
      });
    }
    if (!botKeyMatches(req)) return unauthorized();
    const type = req.headers.get("content-type") ?? "";
    if (!type.includes("application/json")) throw new PortalError("Send JSON.", 415);
    const body = bodySchema.parse(await req.json());
    const result = await ingestBotTrackingLink(ctx, {
      loadNumber: body.loadNumber ?? body.load_number,
      salesOrderNumber: body.salesOrderNumber ?? body.sales_order_number,
      trackingLink: body.trackingLink ?? body.tracking_link,
    });
    return json(result, result.duplicate ? 200 : 201);
  } catch (error) {
    return errorResponse(error);
  }
}
