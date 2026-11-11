import { presentCustomerOrder } from "@/lib/customer-view";
import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { updateCustomerCost } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z
  .object({
    customerCost: z.union([z.string().max(40), z.number(), z.null()]),
  })
  .strict();

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    const { id } = await context.params;
    const raw = await req.json();
    if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some((key) => key !== "customerCost")) {
      throw new PortalError("Send the cost as a dollar amount.");
    }
    const body = bodySchema.parse(raw);
    const order = await updateCustomerCost(await readyPortal(), id, body.customerCost, session);
    return json({ order: presentCustomerOrder(order, session) });
  } catch (error) {
    return errorResponse(error);
  }
}
