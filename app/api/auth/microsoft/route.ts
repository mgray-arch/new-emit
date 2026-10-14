import { randomBytes } from "node:crypto";
import { microsoftAuthorizeUrl, microsoftConfigured, redirectUriFrom, stateCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!microsoftConfigured()) {
    return new Response(null, {
      status: 302,
      headers: { location: "/login?microsoft=unconfigured", "cache-control": "no-store" },
    });
  }
  const state = randomBytes(16).toString("base64url");
  const url = microsoftAuthorizeUrl(state, redirectUriFrom(req));
  return new Response(null, {
    status: 302,
    headers: { location: url, "set-cookie": stateCookie(state), "cache-control": "no-store" },
  });
}
