import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { readCarrierPhoto } from "@/lib/photos";
import { safeFilename } from "@/lib/documents";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const photo = readCarrierPhoto(ctx, id);
    if (!photo) return json({ error: "Photo not found" }, 404);
    if (!getOrder(ctx, photo.loadId)) return json({ error: "Photo not found" }, 404);
    if (photo.held && session.role !== "admin") return json({ error: "Photo not found" }, 404);
    return new Response(Buffer.from(photo.bytes), {
      headers: {
        "content-type": photo.mediaType,
        "content-disposition": `inline; filename="${safeFilename(photo.filename)}"`,
        "cache-control": "private, no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
