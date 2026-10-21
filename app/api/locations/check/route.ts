import { z } from "zod";
import { isSession, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { findDuplicate } from "@/lib/locations";
import { readyPortal } from "@/lib/portal";
import { placeSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const checkSchema = z.object({
  kind: z.enum(["drop", "pickup", "pickup_once"]).optional(),
  place: placeSchema,
  ignoreId: z.string().trim().max(80).nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    const body = checkSchema.parse(await req.json());
    const kind = body.kind === "pickup" || body.kind === "pickup_once" ? "pickup_once" : "drop";
    const ctx = await readyPortal();
    const match = await findDuplicate(ctx, body.place, kind, body.ignoreId);
    return json({ match });
  } catch (error) {
    return errorResponse(error);
  }
}
