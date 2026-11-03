import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { setSelectStaffActive } from "@/lib/select-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  active: z.boolean(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());
    const staff = await setSelectStaffActive(await readyPortal(), id, body.active, session.userId);
    return json({ user: staff });
  } catch (error) {
    return errorResponse(error);
  }
}
