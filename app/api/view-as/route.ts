import { isSession, requireActorAdmin } from "@/lib/guard";
import { errorResponse, json, PortalError } from "@/lib/http";
import { clearViewAsCookie, encodeViewAs, parseViewAs, viewAsCookie } from "@/lib/session";
import type { EmitPermission, ViewAsPreview } from "@/lib/types";
import { z } from "zod";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  access: z.enum(["admin", "regular"]).nullable().optional(),
  permission: z.enum(["view", "add", "pricing", "full"]).optional(),
  profile: z.enum(["sales", "loader"]).nullable().optional(),
  /** Older clients sent a role name. Still accepted. */
  role: z.enum(["emit_admin", "customer", "emit_viewer"]).nullable().optional(),
});

export async function POST(req: Request) {
  try {
    const actor = await requireActorAdmin(req);
    if (!isSession(actor)) return actor;
    const body = bodySchema.parse(await req.json());
    let viewAs: ViewAsPreview | null = null;
    if (body.access) {
      let permission: EmitPermission = body.permission ?? (body.access === "admin" ? "full" : "add");
      const profile = body.profile ?? null;
      if (profile === "loader") permission = "view";
      if (profile === "sales" && (permission === "pricing" || permission === "full")) {
        throw new PortalError("Sales cannot have see pricing or full access.", 400);
      }
      viewAs = { access: body.access, permission, ...(profile ? { profile } : {}) };
    } else if (body.role) {
      viewAs = parseViewAs(body.role);
    }
    return json(
      { viewAs },
      200,
      { "set-cookie": viewAs ? viewAsCookie(encodeViewAs(viewAs)) : clearViewAsCookie() },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
