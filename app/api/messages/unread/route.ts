import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { unreadCount } from "@/lib/messages";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const count = await unreadCount(await readyPortal(), session);
    return json({ count });
  } catch (error) {
    return errorResponse(error);
  }
}
