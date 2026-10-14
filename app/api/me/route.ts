import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    return json({ name: session.name, email: session.email, role: session.role });
  } catch (error) {
    return errorResponse(error);
  }
}
