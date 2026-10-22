import { errorResponse, json } from "@/lib/http";
import { isSession, rejectIfViewingAs, requireSession } from "@/lib/guard";
import { changeOwnPassword } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { sessionCookie, signSession } from "@/lib/session";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  currentPassword: z.string().min(1).max(200),
  newPassword: z.string().min(1).max(200),
});

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const readonly = rejectIfViewingAs(session);
    if (readonly) return readonly;
    const body = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const next = await changeOwnPassword(ctx, session, body.currentPassword, body.newPassword);
    const token = await signSession(next);
    return json({ ok: true }, 200, { "set-cookie": sessionCookie(token) });
  } catch (error) {
    return errorResponse(error);
  }
}
