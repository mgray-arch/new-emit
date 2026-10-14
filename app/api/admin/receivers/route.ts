import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { listReceiverAccess, replaceReceiverAccess } from "@/lib/receivers";
import { receiversSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    return json({ receivers: listReceiverAccess(ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function PUT(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const body = receiversSchema.parse(await req.json());
    return json({ receivers: replaceReceiverAccess(ctx, body.receivers) });
  } catch (error) {
    return errorResponse(error);
  }
}
