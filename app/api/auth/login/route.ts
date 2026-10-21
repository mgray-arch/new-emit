import { errorResponse, json } from "@/lib/http";
import { loginWithPassword } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import { sameOrigin, sessionCookie, signSession } from "@/lib/session";
import { z } from "zod";

function clientAddress(req: Request): string {
  const forwarded = req.headers.get("x-forwarded-for");
  const raw = forwarded?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
  return raw.slice(0, 80);
}

const bodySchema = z.object({
  email: z.string().trim().email(),
  password: z.string().min(1),
});

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: Request) {
  try {
    if (!sameOrigin(req)) return json({ error: "Cross-origin request blocked" }, 403);
    const body = bodySchema.parse(await req.json());
    const ctx = await readyPortal();
    const result = await loginWithPassword(ctx, body.email, body.password, clientAddress(req));
    if (!result.ok) return json({ error: result.error }, result.status);
    const token = await signSession(result.session);
    return json(
      {
        name: result.session.name,
        email: result.session.email,
        role: result.session.role,
        mustChangePassword: result.mustChangePassword,
      },
      200,
      { "set-cookie": sessionCookie(token) },
    );
  } catch (error) {
    return errorResponse(error);
  }
}
