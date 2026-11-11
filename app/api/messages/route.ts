import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { getThread, listThreads, postMessage } from "@/lib/messages";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  body: z.string({ invalid_type_error: "Enter a message." }).max(4000, "Keep the message under 2000 characters."),
  loadId: z.string().trim().max(80).nullable().optional(),
  threadId: z.string().trim().max(80).nullable().optional(),
});

function sideParam(value: string | null): "emit" | "select" | null {
  return value === "emit" || value === "select" ? value : null;
}

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const url = new URL(req.url);
    const raw = url.searchParams.get("beforeSeq");
    const beforeSeq = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    const threadId = url.searchParams.get("thread");
    const loadId = url.searchParams.get("load");
    const ctx = await readyPortal();
    if ((threadId && threadId.length <= 80) || (loadId && loadId.length <= 80)) {
      const detail = await getThread(ctx, session, {
        threadId: threadId && threadId.length <= 80 ? threadId : null,
        loadId: loadId && loadId.length <= 80 ? loadId : null,
        beforeSeq,
      });
      return json(detail);
    }
    const q = (url.searchParams.get("q") ?? "").slice(0, 80);
    const page = await listThreads(ctx, session, {
      q,
      unread: url.searchParams.get("unread") === "1",
      mine: url.searchParams.get("mine") === "1",
      side: sideParam(url.searchParams.get("side")),
    });
    return json(page);
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    let payload: unknown;
    try {
      payload = await req.json();
    } catch {
      throw new PortalError("Enter a message.", 400);
    }
    const input = postSchema.parse(payload);
    const message = await postMessage(await readyPortal(), session, input);
    return json({ message }, 201);
  } catch (error) {
    return errorResponse(error);
  }
}
