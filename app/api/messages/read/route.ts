import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { markMessagesRead } from "@/lib/messages";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    let threadId: string | null = null;
    const text = await req.text();
    if (text.trim()) {
      let payload: unknown;
      try {
        payload = JSON.parse(text);
      } catch {
        throw new PortalError("Choose a thread.", 400);
      }
      if (payload && typeof payload === "object" && "threadId" in payload) {
        const value = (payload as { threadId?: unknown }).threadId;
        if (typeof value === "string" && value.trim()) {
          if (value.trim().length > 80) throw new PortalError("Choose a thread.", 400);
          threadId = value.trim();
        }
      }
    }
    await markMessagesRead(await readyPortal(), session, threadId);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}
