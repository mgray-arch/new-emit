import { safeFilename } from "@/lib/documents";
import { errorResponse, json } from "@/lib/http";
import { getOrder } from "@/lib/orders";
import { hiddenFromReceiver, readCarrierPhoto } from "@/lib/photos";
import { readyPortal } from "@/lib/portal";
import { receiverCompanyForToken } from "@/lib/receivers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(_req: Request, context: { params: Promise<{ token: string; photoId: string }> }) {
  try {
    const { token, photoId } = await context.params;
    const ctx = await readyPortal();
    const receiver = await receiverCompanyForToken(ctx, token);
    if (!receiver) return json({ error: "This link is not valid." }, 404);
    const photo = await readCarrierPhoto(ctx, photoId);
    if (!photo || hiddenFromReceiver(photo)) return json({ error: "Photo not found" }, 404);
    if (!(await getOrder(ctx, photo.loadId, receiver.company))) return json({ error: "Photo not found" }, 404);
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
