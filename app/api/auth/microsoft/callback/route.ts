import { json } from "@/lib/http";
import { upsertExternalUser } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import {
  clearStateCookie,
  cookieValue,
  microsoftConfigured,
  redirectUriFrom,
  roleForEmail,
  sessionCookie,
  signSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  if (!microsoftConfigured()) return json({ error: "Microsoft sign-in is not configured" }, 503);
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookieValue(req, "oauth_state");
  if (!code || !state || !expected || state !== expected) {
    return json({ error: "Microsoft sign-in could not be verified. Start it again from the login page." }, 400, {
      "set-cookie": clearStateCookie(),
    });
  }
  try {
    const tenant = process.env.AZURE_AD_TENANT_ID as string;
    const tokenResponse = await fetch(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: process.env.AZURE_AD_CLIENT_ID as string,
        client_secret: process.env.AZURE_AD_CLIENT_SECRET as string,
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUriFrom(req),
        scope: "openid profile email",
      }),
    });
    if (!tokenResponse.ok) return json({ error: "Microsoft did not accept the sign-in." }, 401);
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    const profileResponse = await fetch("https://graph.microsoft.com/oidc/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) return json({ error: "Microsoft did not return a profile." }, 401);
    const profile = (await profileResponse.json()) as { email?: string; preferred_username?: string; name?: string };
    const email = (profile.email || profile.preferred_username || "").toLowerCase();
    const role = roleForEmail(email);
    if (!email || !role) {
      return json({ error: "This Microsoft account is not authorized for the EMIT portal." }, 403, {
        "set-cookie": clearStateCookie(),
      });
    }
    const ctx = await readyPortal();
    const session = upsertExternalUser(ctx, { email, name: profile.name || email, role });
    const token = await signSession(session);
    const destination = role === "admin" ? "/admin" : "/";
    return new Response(null, {
      status: 302,
      headers: [
        ["location", destination],
        ["cache-control", "no-store"],
        ["set-cookie", sessionCookie(token)],
        ["set-cookie", clearStateCookie()],
      ],
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Microsoft sign-in failed." }, 500);
  }
}
