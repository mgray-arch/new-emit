import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { listSites } from "@/lib/sites";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    return json({ sites: await listSites(ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}
