import { identityFromGoogle } from "@/lib/auth-policy";
import { json } from "@/lib/http";
import { upsertExternalUser } from "@/lib/passwords";
import { readyPortal } from "@/lib/portal";
import {
  clearStateCookie,
  cookieValue,
  googleConfigured,
  oauthCallbackUrl,
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
  if (!googleConfigured()) return loginError("Google sign-in is not configured.");
  const url = new URL(req.url);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expected = cookieValue(req, "oauth_state");
  if (!code || !state || !expected || state !== expected || !state.startsWith("google.")) {
    return loginError("Google sign-in could not be verified. Start it again from the login page.");
  }
  try {
    const tokenResponse = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        code,
        client_id: process.env.GOOGLE_CLIENT_ID as string,
        client_secret: process.env.GOOGLE_CLIENT_SECRET as string,
        redirect_uri: oauthCallbackUrl(req, "google"),
        grant_type: "authorization_code",
      }),
    });
    if (!tokenResponse.ok) return loginError("Google did not accept the sign-in.");
    const tokens = (await tokenResponse.json()) as { access_token?: string };
    const profileResponse = await fetch("https://openidconnect.googleapis.com/v1/userinfo", {
      headers: { authorization: `Bearer ${tokens.access_token}` },
    });
    if (!profileResponse.ok) return loginError("Google did not return a profile.");
    const profile = (await profileResponse.json()) as {
      email?: string;
      email_verified?: boolean;
      hd?: string;
      name?: string;
    };
    const decision = identityFromGoogle({
      email: profile.email || "",
      emailVerified: profile.email_verified === true,
      hostedDomain: profile.hd || null,
    });
    if (!decision.ok) return loginError(decision.error);
    const ctx = await readyPortal();
    const session = await upsertExternalUser(ctx, {
      email: decision.email,
      name: profile.name || decision.email,
      role: decision.role,
    });
    const token = await signSession(session);
    return new Response(null, {
      status: 302,
      headers: [
        ["location", "/admin"],
        ["cache-control", "no-store"],
        ["set-cookie", sessionCookie(token)],
        ["set-cookie", clearStateCookie()],
      ],
    });
  } catch (error) {
    console.error(error);
    return json({ error: "Google sign-in failed." }, 500);
  }
}
