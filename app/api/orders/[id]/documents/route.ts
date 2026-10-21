import { presentCustomerOrder } from "@/lib/customer-view";
import { ingestDocument } from "@/lib/documents";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json, PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { canAddLoads } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    if (!canAddLoads(session.role)) return json({ error: "This account can view loads but cannot add files." }, 403);
    if (!(await getOrder(ctx, id))) return json({ error: "Order not found" }, 404);
    const form = await req.formData();
    const file = form.get("file");
    const slot = form.get("slot") === "bol" ? "bol" : "attachment";
    if (!(file instanceof File)) throw new PortalError("Choose a file to upload");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestDocument(ctx, { loadId: id, filename: file.name, bytes, slot });
    const order = await getOrder(ctx, id);
    const presented = order ? presentCustomerOrder(order, session.role) : null;
    if (session.role !== "admin") return json({ order: presented });
    return json({
      released: result.releasedIds.length,
      heldForReview: result.heldIds.length,
      order: presented,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
