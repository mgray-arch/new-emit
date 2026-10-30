import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse, json } from "@/lib/http";
import { isSession, rejectIfViewingAs, requireAdmin } from "@/lib/guard";
import { setLoadCarrier } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  carrierName: z.string().max(120).nullable().optional(),
  carrierMc: z.string().max(20).nullable().optional(),
  driverName: z.string().max(80).nullable().optional(),
});

/** Select sets driver, carrier company, and MC. Carrier pay is not accepted. */
export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    const { id } = await context.params;
    const body = bodySchema.parse(await req.json());
    const order = await setLoadCarrier(await readyPortal(), id, body);
    return json({ order: presentCustomerOrder(order, session) });
  } catch (error) {
    return errorResponse(error);
  }
}
