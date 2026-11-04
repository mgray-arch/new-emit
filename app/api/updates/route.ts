import { countUnseen } from "@/lib/carrier-seen";
import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** How many loads have a carrier update or a new tracking link this person has not opened. */
export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const count = await countUnseen(await readyPortal(), session.userId);
    return json({ count });
  } catch (error) {
    return errorResponse(error);
  }
}
