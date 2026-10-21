import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { updateEmitUser } from "@/lib/users";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const patchSchema = z.object({
  name: z.string().trim().min(1, "Name is required.").max(120).optional(),
  active: z.boolean().optional(),
  password: z.string().min(10, "Use at least 10 characters.").max(200).optional(),
  generatePassword: z.boolean().optional(),
});

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = patchSchema.parse(await req.json());
    const result = await updateEmitUser(await readyPortal(), id, body);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
