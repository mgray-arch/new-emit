import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { findUser } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const user = await findUser(await readyPortal(), session.email);
    return json({
      name: session.name,
      email: session.email,
      role: session.role,
      mustChangePassword: Boolean(user?.mustChangePassword),
      hasPassword: Boolean(user?.passwordHash),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
