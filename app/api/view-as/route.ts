import { isSession, requireActorAdmin } from "@/lib/guard";
import { errorResponse, json } from "@/lib/http";
import { clearViewAsCookie, viewAsCookie } from "@/lib/session";
import type { PortalRole } from "@/lib/types";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  role: z.enum(["emit_admin", "customer", "emit_viewer"]).nullable(),
});

export async function POST(req: Request) {
  try {
    const actor = await requireActorAdmin(req);
    if (!isSession(actor)) return actor;
    const body = bodySchema.parse(await req.json());
    const viewAs = body.role as PortalRole | null;
    return json(
      { viewAs },
      200,
      { "set-cookie": viewAs ? viewAsCookie(viewAs) : clearViewAsCookie() },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
