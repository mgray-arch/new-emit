import { documentPrintHtml } from "@/lib/document-print";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readCarrierPhoto } from "@/lib/photos";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Phone-friendly print page for a carrier photo. A held photo stays hidden from EMIT. */
export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const photo = await readCarrierPhoto(ctx, id);
    if (!photo || !(await getOrder(ctx, photo.loadId))) return json({ error: "Photo not found" }, 404);
    if (photo.held && session.role !== "admin") return json({ error: "Photo not found" }, 404);
    const html = documentPrintHtml({
      src: `/api/carrier-photos/${encodeURIComponent(id)}`,
      filename: photo.filename,
      mediaType: photo.mediaType,
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
