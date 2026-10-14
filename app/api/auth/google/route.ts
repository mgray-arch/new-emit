import { randomBytes } from "node:crypto";
import { googleAuthorizeUrl, googleConfigured, oauthCallbackUrl, stateCookie } from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!googleConfigured()) {
    return new Response(null, {
      status: 302,
      headers: { location: "/login?google=unconfigured", "cache-control": "no-store" },
    });
  }
  const state = `google.${randomBytes(16).toString("base64url")}`;
  const url = googleAuthorizeUrl(state, oauthCallbackUrl(req, "google"));
  return new Response(null, {
    status: 302,
    headers: { location: url, "set-cookie": stateCookie(state), "cache-control": "no-store" },
  });
}
