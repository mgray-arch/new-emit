import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireAdmin } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { resetSelectPassword } from "@/lib/select-staff";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  password: z.string().max(200).optional(),
  generatePassword: z.boolean().optional(),
});

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = bodySchema.parse(await req.json());
    const result = await resetSelectPassword(await readyPortal(), id, body);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
