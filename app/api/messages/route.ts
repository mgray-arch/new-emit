import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { listMessages, postMessage } from "@/lib/messages";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const postSchema = z.object({
  body: z.string({ invalid_type_error: "Enter a message." }).max(4000, "Keep the message under 2000 characters."),
  loadId: z.string().trim().max(80).nullable().optional(),
});

export async function GET(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const url = new URL(req.url);
    const raw = url.searchParams.get("beforeSeq");
    const beforeSeq = raw && /^\d+$/.test(raw) ? Number(raw) : null;
    const page = await listMessages(await readyPortal(), session, beforeSeq);
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
