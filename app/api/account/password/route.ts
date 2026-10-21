import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { changeOwnPassword } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  currentPassword: z.string().min(1, "Current password is required."),
  newPassword: z.string().min(10, "Use at least 10 characters.").max(200),
});

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const body = bodySchema.parse(await req.json());
    await changeOwnPassword(await readyPortal(), session, body.currentPassword, body.newPassword);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
