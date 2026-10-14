import { readInternalDocumentFile, reviewDocument, safeFilename } from "@/lib/documents";
import { isSession, requireAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { readyPortal } from "@/lib/portal";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = z.object({ action: z.enum(["approve", "reject"]) }).parse(await req.json());
    const ctx = await readyPortal();
    reviewDocument(ctx, id, body.action, session.email);
    return json({ ok: true });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireAdmin(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const ctx = await readyPortal();
    const file = readInternalDocumentFile(ctx, id);
    if (!file) return json({ error: "Document not found" }, 404);
    return new Response(Buffer.from(file.bytes), {
      headers: {
        "content-type": file.mediaType,
        "content-disposition": `attachment; filename="${safeFilename(file.filename)}"`,
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
