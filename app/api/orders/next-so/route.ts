import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { nextSalesOrderSuffix } from "@/lib/orders";
import { readyPortal } from "@/lib/portal";
import { canAddLoads } from "@/lib/types";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Suggests the next _T suffix. The suggestion is advisory; saving checks for a conflict. */
export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    if (session.viewAs || !canAddLoads(session)) throw new PortalError("This account cannot add loads.", 403);
    const so = new URL(req.url).searchParams.get("so")?.trim() ?? "";
    if (!so) throw new PortalError("Enter a sales order number.");
    const next = await nextSalesOrderSuffix(await readyPortal(), so);
    return json({ base: next.base, highestInUse: next.highestInUse, suggestion: next.suggestion, tooLong: next.tooLong });
  } catch (error) {
    return errorResponse(error);
  }
}
