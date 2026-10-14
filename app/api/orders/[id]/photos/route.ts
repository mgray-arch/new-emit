import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { listCarrierPhotos } from "@/lib/photos";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const order = await getOrder(ctx, id);
    if (!order) return json({ error: "Order not found" }, 404);
    const includeHeld = session.role === "admin";
    const photos = (await listCarrierPhotos(ctx, id, includeHeld)).map((photo) => ({
      id: photo.id,
      filename: photo.filename,
      mediaType: photo.mediaType,
      source: photo.source,
      subject: photo.subject,
      receivedAt: photo.receivedAt,
      held: includeHeld ? photo.held : false,
      holdReason: includeHeld && photo.held ? photo.holdReason : null,
    }));
    return json({ photos });
  } catch (error) {
    return errorResponse(error);
  }
}
