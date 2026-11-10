import { coverLoadFromReleasedBol } from "@/lib/bol-coverage";
import { presentCustomerOrder } from "@/lib/customer-view";
import { ingestDocument } from "@/lib/documents";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { errorResponse, json, PortalError } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { canUploadBol, canUploadDocs } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const form = await req.formData();
    const file = form.get("file");
    const slot = form.get("slot") === "bol" ? "bol" : "attachment";
    const allowed = slot === "bol" ? canUploadBol(session) : canUploadDocs(session);
    if (!allowed) return json({ error: "This account can view loads but cannot add files." }, 403);
    if (!(await getOrder(ctx, id))) return json({ error: "Order not found" }, 404);
    if (!(file instanceof File)) throw new PortalError("Choose a file to upload");
    const bytes = new Uint8Array(await file.arrayBuffer());
    const result = await ingestDocument(ctx, { loadId: id, filename: file.name, bytes, slot });
    if (slot === "bol" && result.releasedIds.length > 0) {
      await coverLoadFromReleasedBol(ctx, id, result.releasedTexts.join("\n"));
    }
    const order = await getOrder(ctx, id);
    const presented = order ? presentCustomerOrder(order, session) : null;
    if (session.role !== "admin" || session.viewAs) return json({ order: presented });
    return json({
      released: result.releasedIds.length,
      heldForReview: result.heldIds.length,
      order: presented,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
