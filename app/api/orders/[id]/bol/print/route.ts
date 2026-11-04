import { listBolPages, recordBolPrint } from "@/lib/bol-print";
import { bolPrintHtml } from "@/lib/document-print";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Open the uploaded BOL for printing. A missing BOL is not the order screen. Rate confirmations are not here. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    if (!(await getOrder(ctx, id))) return json({ error: "Order not found" }, 404);
    const pages = await listBolPages(ctx, id);
    if (!pages.length) return json({ error: "BOL not uploaded yet" }, 404);
    await recordBolPrint(ctx, { loadId: id, documentId: pages[0].id, userId: session.userId });
    const html = bolPrintHtml(
      pages.map((page) => ({
        src: `/api/documents/${encodeURIComponent(page.id)}`,
        filename: page.filename,
        mediaType: page.mediaType,
      })),
    );
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
