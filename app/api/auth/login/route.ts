import { errorResponse, json } from "@/lib/http";
import { clientIp, loginWithPassword } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { blockingSetupError, emptyAccountMessage, setupFailureMessage } from "@/lib/runtime-config";
import { sameOrigin, sessionCookie, signSession } from "@/lib/session";
import { z } from "zod";

const bodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1).max(200),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return json({ error: "Cross-origin request blocked" }, 403);
    const blocked = blockingSetupError();
    if (blocked) return json({ error: blocked }, 503);
    const body = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const result = await loginWithPassword(ctx, body.email, body.password, clientIp(req));
    if (!result.ok) {
      if (result.reason === "invalid") {
        const empty = await emptyAccountMessage(ctx);
        if (empty) return json({ error: empty }, 503);
      }
      if (result.reason === "locked") {
        return json(
          { error: "Too many sign-in attempts. Try again in 15 minutes." },
          429,
          { "retry-after": String(result.retryAfterSeconds ?? 900) },
        );
      }
      if (result.reason === "inactive") {
        return json({ error: "This account is deactivated. Ask a Select admin to turn it back on." }, 403);
      }
      return json({ error: "Invalid email or password" }, 401);
    }
    const token = await signSession(result.session);
    return json(
      { name: result.session.name, email: result.session.email, role: result.session.role },
      200,
      { "set-cookie": sessionCookie(token) },
    );
  } catch (error) {
    const setup = setupFailureMessage(error);
    if (setup) return json({ error: setup }, 503);
    return errorResponse(error);
  }
}
