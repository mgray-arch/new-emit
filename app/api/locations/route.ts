import { isSession, requireLocationReader, requireSession } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { listManagedLocations, searchLocations, type LocationKind } from "@/lib/locations";
import { readyPortal } from "@/lib/portal";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const manage = url.searchParams.get("manage") === "1";
    const session = manage ? await requireLocationReader(req) : await requireSession(req);
    if (!isSession(session)) return session;
    const ctx = await readyPortal();
    if (manage) {
      return json({ locations: await listManagedLocations(ctx, url.searchParams.get("q") ?? "") });
    }
    const kind: LocationKind = url.searchParams.get("kind") === "pickup_once" ? "pickup_once" : "drop";
    const limit = Number(url.searchParams.get("limit") || "8");
    return json({
      locations: await searchLocations(ctx, {
        q: url.searchParams.get("q") ?? "",
        kind,
        limit: Number.isFinite(limit) ? limit : 8,
      }),
    });
  } catch (error) {
    return errorResponse(error);
  }
}
