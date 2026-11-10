import { listInboundEmails } from "@/lib/inbound-email";
import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    return json({ emails: await listInboundEmails(ctx) });
  } catch (error) {
    return errorResponse(error);
  }
}
