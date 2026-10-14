import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { createReceiver, listReceivers } from "@/lib/receivers";
import { receiverCreateSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    return json({ receivers: listReceivers(ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    const body = receiverCreateSchema.parse(await req.json());
    return json({ receiver: createReceiver(ctx, body) }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
