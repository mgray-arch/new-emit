import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { assignSelectLoadNumber } from "@/lib/select-load";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  loadNumber: z.string().max(40),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const order = await assignSelectLoadNumber(ctx, id, body.loadNumber, "admin");
    return json({ order });
  } catch (error) {
    return errorResponse(error);
  }
}
