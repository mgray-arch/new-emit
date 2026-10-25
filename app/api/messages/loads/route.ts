import { errorResponse, json } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { searchMessageLoads } from "@/lib/messages";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const url = new URL(req.url);
    const include = url.searchParams.get("include");
    const loads = await searchMessageLoads(
      await readyPortal(),
      session,
      url.searchParams.get("q") ?? "",
      include && include.length <= 80 ? include : null,
    );
    return json({ loads });
  } catch (error) {
    return errorResponse(error);
  }
}
