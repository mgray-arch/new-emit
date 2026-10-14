import { jwtVerify, SignJWT } from "jose";
import { safeNextPath } from "@/lib/paths";
import type { Session } from "@/lib/types";

export { safeNextPath };

const COOKIE = "portal_session";
const STATE_COOKIE = "oauth_state";

export function authSecret(): Uint8Array {
  const secret = process.env.AUTH_SECRET;
  if (!secret || secret.length < 16) {
    if (process.env.NODE_ENV === "production") {
      throw new Error("AUTH_SECRET must be set to a long random string in production");
    }
    return new TextEncoder().encode("dev-only-insecure-secret-do-not-deploy");
  }
  return new TextEncoder().encode(secret);
}

export async function signSession(session: Session): Promise<string> {
  return new SignJWT({
    email: session.email,
    name: session.name,
    role: session.role,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt()
    .setExpirationTime("7d")
    .sign(authSecret());
}

export async function verifySessionToken(token: string): Promise<Session | null> {
  try {
    const { payload } = await jwtVerify(token, authSecret());
    if (payload.role !== "customer" && payload.role !== "admin" && payload.role !== "receiver") return null;
    if (typeof payload.email !== "string" || typeof payload.name !== "string" || typeof payload.sub !== "string") {
      return null;
    }
    return { userId: payload.sub, email: payload.email, name: payload.name, role: payload.role };
  } catch {
    return null;
  }
}

export function cookieValue(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [rawKey, ...rest] = part.trim().split("=");
    if (rawKey === name) return decodeURIComponent(rest.join("="));
  }
  return null;
}

export async function readSession(req: Request): Promise<Session | null> {
  const token = cookieValue(req, COOKIE);
  if (!token) return null;
  return verifySessionToken(token);
}

export function sessionCookie(token: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${60 * 60 * 24 * 7}${secure}`;
}

export function clearSessionCookie(): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

export function stateCookie(state: string): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${STATE_COOKIE}=${state}; HttpOnly; Path=/; SameSite=Lax; Max-Age=600${secure}`;
}

export function clearStateCookie(): string {
  return `${STATE_COOKIE}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0`;
}

export function isPublicPath(pathname: string): boolean {
  if (pathname === "/login") return true;
  if (pathname === "/api/auth/login" || pathname === "/api/auth/logout") return true;
  if (pathname === "/api/auth/microsoft" || pathname.startsWith("/api/auth/microsoft/")) return true;
  if (pathname === "/api/auth/google" || pathname.startsWith("/api/auth/google/")) return true;
  if (pathname.startsWith("/track/")) return true;
  if (pathname.startsWith("/api/track/")) return true;
  // The Gmail assistant authenticates with a bearer token, not the session cookie.
  // The handler rejects every request that lacks that token or an admin session.
  if (pathname === "/api/ingest/carrier-photos") return true;
  return false;
}

export function oauthCallbackUrl(req: Request, provider: "microsoft" | "google"): string {
  const path = `/api/auth/${provider}/callback`;
  const configured = process.env.PORTAL_PUBLIC_URL?.replace(/\/$/, "");
  if (configured) return `${configured}${path}`;
  const host = req.headers.get("host") || "localhost:3000";
  const proto = req.headers.get("x-forwarded-proto") || "http";
  return `${proto}://${host}${path}`;
}

export function sameOrigin(req: Request): boolean {
  const origin = req.headers.get("origin");
  if (!origin) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

export function microsoftConfigured(): boolean {
  return Boolean(process.env.AZURE_AD_TENANT_ID && process.env.AZURE_AD_CLIENT_ID && process.env.AZURE_AD_CLIENT_SECRET);
}

export function microsoftAuthorizeUrl(state: string, redirectUri: string): string {
  const tenant = process.env.AZURE_AD_TENANT_ID;
  const clientId = process.env.AZURE_AD_CLIENT_ID;
  if (!tenant || !clientId) {
    throw new Error("Microsoft sign-in is not configured");
  }
  const url = new URL(`https://login.microsoftonline.com/${tenant}/oauth2/v2.0/authorize`);
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("response_mode", "query");
  url.searchParams.set("scope", "openid profile email");
  url.searchParams.set("state", state);
  return url.toString();
}

export function redirectUriFrom(req: Request): string {
  return oauthCallbackUrl(req, "microsoft");
}

export function googleConfigured(): boolean {
  return Boolean(process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_SECRET);
}

export function googleAuthorizeUrl(state: string, redirectUri: string): string {
  const clientId = process.env.GOOGLE_CLIENT_ID;
  if (!clientId) throw new Error("Google sign-in is not configured");
  const domain = (process.env.GOOGLE_HOSTED_DOMAIN || "goselect.com").trim().toLowerCase();
  const url = new URL("https://accounts.google.com/o/oauth2/v2/auth");
  url.searchParams.set("client_id", clientId);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", "openid email profile");
  url.searchParams.set("state", state);
  url.searchParams.set("hd", domain);
  url.searchParams.set("prompt", "select_account");
  return url.toString();
}
