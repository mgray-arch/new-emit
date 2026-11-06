import { recordBolPrint } from "@/lib/bol-print";
import { documentPrintHtml } from "@/lib/document-print";
import { readCustomerDocument } from "@/lib/documents";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phone-friendly print page for a customer file. Rate confirmations are not on this route. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const doc = await readCustomerDocument(ctx, id);
    if (!doc || !(await getOrder(ctx, doc.loadId))) return json({ error: "Document not found" }, 404);
    if (doc.kind === "bol") await recordBolPrint(ctx, { loadId: doc.loadId, documentId: doc.id, userId: session.userId });
    const html = documentPrintHtml({
      src: `/api/documents/${encodeURIComponent(id)}`,
      filename: doc.filename,
      mediaType: doc.mediaType,
    });
    return new Response(html, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
