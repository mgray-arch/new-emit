import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { readyPortal } from "@/lib/portal";
import { chatEnabledFor } from "@/lib/users";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const chatEnabled = await chatEnabledFor(await readyPortal(), session);
    return json({
      name: session.name,
      email: session.email,
      role: session.role,
      permission: session.permission ?? null,
      actorRole: session.actorRole ?? session.role,
      viewAs: session.viewAs ?? null,
      readOnly: Boolean(session.viewAs),
      chatEnabled,
    });
  } catch (error) {
    return errorResponse(error);
  }
}
