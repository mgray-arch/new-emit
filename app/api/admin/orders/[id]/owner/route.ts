import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { setLoadOwner } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  owner: z.enum(["Drew", "Ainsley"]),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = bodySchema.parse(await req.json());
    const order = await setLoadOwner(await readyPortal(), id, body.owner);
    return json({ order: presentCustomerOrder(order, session) });
  } catch (error) {
    return errorResponse(error);
  }
}
