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
    const body = z
      .object({ action: z.enum(["approve", "reject"]), confirm: z.boolean().optional() })
      .parse(await req.json());
    const ctx = await readyPortal();
    const result = await reviewDocument(ctx, id, body.action, session.email, { confirm: body.confirm });
    return json({ ok: true, ...result });
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
    const file = await readInternalDocumentFile(ctx, id);
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
