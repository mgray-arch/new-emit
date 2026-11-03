import { z } from "zod";
import { errorResponse, json } from "@/lib/http";
import { clientIp, loginLockStatus, noteFailedLogin } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { claimSelectPassword, selectSetupEnabled, setupKeyMatches } from "@/lib/select-staff";
import { sameOrigin } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const bodySchema = z.object({
  email: z.string().trim().email().max(200),
  password: z.string().min(1).max(200),
  name: z.string().trim().max(80).optional(),
  setupKey: z.string().max(200).optional(),
});

/** One-time Select password setup. Closed unless SELECT_SETUP_KEY is set. The password is not returned. */
export async function POST(req: Request) {
  try {
    if (!selectSetupEnabled()) return json({ error: "Not found" }, 404);
    if (!sameOrigin(req)) return json({ error: "Cross-origin request blocked" }, 403);
    const ctx = await readyPortal();
    const ip = clientIp(req);
    const locked = await loginLockStatus(ctx, "select-setup", ip);
    if (locked.locked) {
      return json({ error: "Too many attempts. Try again in 15 minutes." }, 429, {
        "retry-after": String(locked.retryAfterSeconds),
      });
    }
    const body = bodySchema.parse(await req.json());
    const header = req.headers.get("authorization") ?? "";
    const bearer = header.toLowerCase().startsWith("bearer ") ? header.slice(7).trim() : "";
    if (!setupKeyMatches(bearer || body.setupKey || "")) {
      const after = await noteFailedLogin(ctx, "select-setup", ip);
      if (after.locked) {
        return json({ error: "Too many attempts. Try again in 15 minutes." }, 429, {
          "retry-after": String(after.retryAfterSeconds),
        });
      }
      return json({ error: "Setup key was not accepted." }, 401);
    }
    const result = await claimSelectPassword(ctx, body);
    return json({ ok: true, email: result.email, created: result.created });
  } catch (error) {
    return errorResponse(error);
  }
}
