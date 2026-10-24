import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    return json({
      name: session.name,
      email: session.email,
      role: session.role,
      permission: session.permission ?? null,
      actorRole: session.actorRole ?? session.role,
      viewAs: session.viewAs ?? null,
      readOnly: Boolean(session.viewAs),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
