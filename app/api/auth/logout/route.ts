import { json } from "@/lib/http";
import { clearSessionCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  return json({ ok: true }, 200, { "set-cookie": clearSessionCookie() });
}
