import { cronAuthorized, promoteDeliveredLoads } from "@/lib/delivery";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * Daily at 12:00 UTC, which is 5:00 AM America/Boise.
 * Boise stays on Mountain Standard Time (UTC-7) all year, so this does not shift in the summer.
 * Vercel calls GET with `Authorization: Bearer $CRON_SECRET` when that variable is set.
 */
export async function GET(req: Request) {
  try {
    if (!cronAuthorized(req)) return json({ error: "Unauthorized" }, 401);
    const result = await promoteDeliveredLoads(await readyPortal());
    return json({ ok: true, delivered: result.delivered, loadIds: result.loadIds });
  } catch (error) {
    return errorResponse(error);
  }
}
