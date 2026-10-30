import { recordBolPrint } from "@/lib/bol-prints";
import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { canPrintBol } from "@/lib/types";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  documentId: z.string().trim().min(1).max(80),
});

/**
 * Records a print of an uploaded BOL. This does not generate a BOL.
 * Opening the file with View or Download, or using the browser print dialog, is not recorded.
 */
export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    if (!canPrintBol(session)) throw new PortalError("This account cannot print a BOL.", 403);
    const { id } = await context.params;
    const { documentId } = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const order = await getOrder(ctx, id);
    if (!order) return json({ error: "Order not found" }, 404);
    const result = await recordBolPrint(ctx, {
      loadId: id,
      documentId,
      printedById: session.userId,
      printedByName: session.name,
      carrier: {
        carrierName: order.carrierName ?? null,
        carrierMc: order.carrierMc ?? null,
        driverName: order.driverName ?? null,
      },
    });
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
