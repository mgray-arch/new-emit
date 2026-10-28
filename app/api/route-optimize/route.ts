import { z } from "zod";
import { errorResponse, json, PortalError } from "@/lib/http";
import { isSession, requireSession } from "@/lib/guard";
import { censusGeocoder, MAX_ROUTE_STOPS, optimizeStops } from "@/lib/route-optimize";
import { canAddLoads } from "@/lib/types";
import { placeSchema } from "@/lib/validate";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  stops: z
    .array(z.object({ id: z.string().trim().min(1).max(80), kind: z.enum(["pickup", "drop"]), place: placeSchema }))
    .min(2)
    .max(MAX_ROUTE_STOPS),
});

/** Suggests a drop order. Read-only: nothing is saved until the user accepts and saves the load. */
export async function POST(req: Request) {
  try {
    const session = await requireSession(req);
    if (!isSession(session)) return session;
    if (session.viewAs || !canAddLoads(session)) throw new PortalError("This account cannot change routes.", 403);
    const { stops } = bodySchema.parse(await req.json());
    if (stops.filter((stop) => stop.kind === "drop").length < 2) {
      throw new PortalError("Add at least two drops to optimize the route.");
    }
    const result = await optimizeStops(stops, censusGeocoder());
    if ("error" in result) return json(result, 422);
    return json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
