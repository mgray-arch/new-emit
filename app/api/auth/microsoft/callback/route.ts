import { identityFromMicrosoft } from "@/lib/auth-policy";
import { json, PortalError } from "@/lib/http";
import { upsertExternalUser } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import {
  clearStateCookie,
  cookieValue,
  microsoftConfigured,
  redirectUriFrom,
  sessionCookie,
  signSession,
} from "@/lib/session";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function loginError(message: string): Response {
  return new Response(null, {
    status: 302,
    headers: [
      ["location", `/login?error=${encodeURIComponent(message)}`],
      ["cache-control", "no-store"],
      ["set-cookie", clearStateCookie()],
    ],
  });
}

export async function GET(req: Request) {
  if (!microsoftConfigured()) return loginError("Microsoft sign-in is not configured.");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookieValue(req, "oauth_state");
  if (!code || !state || !expected || state !== expected || !state.startsWith("microsoft.")) {
    return loginError("Microsoft sign-in could not be verified. Start it again from the login page.");
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
    if (!tokenResponse.ok) return loginError("Microsoft did not accept the sign-in.");
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    const profileResponse = await fetch("https://graph.microsoft.com/oidc/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) return loginError("Microsoft did not return a profile.");
    const profile = (await profileResponse.json()) as { email?: string; preferred_username?: string; name?: string };
    const email = profile.email || profile.preferred_username || "";
    const ctx = await readyPortal();
    const decision = identityFromMicrosoft(email);
    if (!decision.ok) return loginError(decision.error);
    const session = await upsertExternalUser(ctx, {
      email: decision.email,
      name: profile.name || decision.email,
      role: decision.role,
    });
    const token = await signSession(session);
    return new Response(null, {
      status: 302,
      headers: [
        ["location", "/"],
        ["cache-control", "no-store"],
        ["set-cookie", sessionCookie(token)],
        ["set-cookie", clearStateCookie()],
      ],
    });
  } catch (error) {
    if (error instanceof PortalError) return loginError(error.message);
    console.error(error);
    return json({ error: "Microsoft sign-in failed." }, 500);
  }
}
