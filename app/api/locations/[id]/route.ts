import { isSession, requireLocationEditor } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { updateLocation } from "@/lib/locations";
import { readyPortal } from "@/lib/portal";
import { locationPatchSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function PATCH(req: Request, context: { params: Promise<{ id: string }> }) {
  try {
    const session = await requireLocationEditor(req);
    if (!isSession(session)) return session;
    const { id } = await context.params;
    const patch = locationPatchSchema.parse(await req.json());
    const ctx = await readyPortal();
    return json({ location: await updateLocation(ctx, id, patch) });
  } catch (error) {
    return errorResponse(error);
  }
}
