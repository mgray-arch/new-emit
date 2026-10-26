import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { markMessagesRead } from "@/lib/messages";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    await markMessagesRead(await readyPortal(), session);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
