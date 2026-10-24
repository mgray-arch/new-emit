import { z } from "zod";
import { isSession, requireLocationEditor } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { mergeLocations } from "@/lib/locations";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireLocationEditor(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const body = z.object({ intoId: z.string().trim().min(1).max(80) }).parse(await req.json());
    const ctx = await readyPortal();
    return json({ location: await mergeLocations(ctx, id, body.intoId) });
  } catch (error) {
    return errorResponse(error);
  }
}
