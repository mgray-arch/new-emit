import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { assignTrackingLink } from "@/lib/select-load";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  trackingLink: z.string().max(2000),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const order = await assignTrackingLink(ctx, id, body.trackingLink, "admin");
    return json({ order });
  } catch (error) {
    return errorResponse(error);
  }
}
