import { documentContentDisposition, wantsDocumentDownload } from "@/lib/document-view";
import { readCustomerDocument } from "@/lib/documents";
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
    const doc = await readCustomerDocument(ctx, id);
    if (!doc || !(await getOrder(ctx, doc.loadId))) return json({ error: "Document not found" }, 404);
    const download = wantsDocumentDownload(new URL(req.url).searchParams.get("download"));
    return new Response(Buffer.from(doc.bytes), {
      headers: {
        "content-type": doc.mediaType,
        "content-disposition": documentContentDisposition(doc.mediaType, doc.filename, download),
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
