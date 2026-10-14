import { errorResponse, json } from "@/lib/http";
import { loginWithPassword, passwordLoginAllowed } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { sameOrigin, sessionCookie, signSession } from "@/lib/session";
import { z } from "zod";

const bodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return json({ error: "Cross-origin request blocked" }, 403);
    if (!passwordLoginAllowed()) {
      return json({ error: "Sign in with Microsoft or Google." }, 403);
    }
    const body = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const session = await loginWithPassword(ctx, body.email, body.password);
    if (!session) return json({ error: "Invalid email or password" }, 401);
    const token = await signSession(session);
    return json(
      { name: session.name, email: session.email, role: session.role },
      200,
      { "set-cookie": sessionCookie(token) },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
