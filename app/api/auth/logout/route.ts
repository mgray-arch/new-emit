import { json } from "@/lib/http";
import { clearSessionCookie, clearViewAsCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST() {
  const headers = new Headers();
  headers.append("set-cookie", clearSessionCookie());
  headers.append("set-cookie", clearViewAsCookie());
  return json({ ok: true }, 200, headers);
}
