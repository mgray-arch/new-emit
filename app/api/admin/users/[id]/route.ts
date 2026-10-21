import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { updateEmitUser } from "@/lib/users";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  active: z.boolean().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());
    const ctx = await readyPortal();
    const user = await updateEmitUser(ctx, id, body);
    return json({ user });
  } catch (error) {
    return errorResponse(error);
  }
}
