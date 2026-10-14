import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { listSites, replaceSites } from "@/lib/sites";
import { sitesSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    return json({ sites: listSites(ctx, true) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const body = sitesSchema.parse(await req.json());
    return json({ sites: replaceSites(ctx, body.sites) });
  } catch (error) {
    return errorResponse(error);
  }
}
