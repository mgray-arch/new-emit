import { readCustomerDocument, safeFilename } from "@/lib/documents";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const doc = readCustomerDocument(ctx, id);
    if (!doc || !getOrder(ctx, doc.loadId)) return json({ error: "Document not found" }, 404);
    return new Response(Buffer.from(doc.bytes), {
      headers: {
        "content-type": doc.mediaType,
        "content-disposition": `attachment; filename="${safeFilename(doc.filename)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
