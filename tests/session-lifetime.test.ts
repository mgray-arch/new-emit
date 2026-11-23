import { readFileSync } from "node:fs";
import { SignJWT, decodeJwt } from "jose";
import { NextRequest } from "next/server";
import { describe, expect, it } from "vitest";
import { middleware } from "@/middleware";
import {
  SESSION_MAX_AGE_SECONDS,
  SESSION_REFRESH_AFTER_SECONDS,
  authSecret,
  isPublicPath,
  rollingSessionCookie,
  sessionCookie,
  sessionNeedsRefresh,
  signSession,
  stateCookie,
  verifySessionToken,
  viewAsCookie,
} from "@/lib/session";
import type { Session } from "@/lib/types";

const DAY = 60 * 60 * 24;

const emit: Session = {
  userId: "customer-1",
  email: "acollier@emittechnologies.com",
  name: "Alex Collier",
  role: "customer",
  passwordEpoch: 3,
};

const select: Session = {
  userId: "admin-1",
  email: "mgray@goselect.com",
  name: "Mike Gray",
  role: "admin",
  passwordEpoch: 1,
};

async function tokenIssuedAt(session: Session, issuedAt: number): Promise<string> {
  return new SignJWT({
    email: session.email,
    name: session.name,
    role: session.role,
    pwd: session.passwordEpoch ?? 0,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(session.userId)
    .setIssuedAt(issuedAt)
    .setExpirationTime(issuedAt + SESSION_MAX_AGE_SECONDS)
    .sign(authSecret());
}

function cookieHeader(token: string, extra = ""): string {
  return extra ? `portal_session=${token}; ${extra}` : `portal_session=${token}`;
}

describe("signed-in session lifetime", () => {
  it("keeps a new sign-in for 30 days and does not use a 5-minute cookie", async () => {
    const token = await signSession(emit);
    const claims = decodeJwt(token);
    expect(claims.exp! - claims.iat!).toBe(SESSION_MAX_AGE_SECONDS);
    expect(SESSION_MAX_AGE_SECONDS).toBe(30 * DAY);
    expect(claims.exp! - claims.iat!).toBeGreaterThan(7 * DAY);

    const cookie = sessionCookie(token);
    expect(cookie).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Path=/");
    expect(cookie).not.toMatch(/Max-Age=300(?!\d)/);
    expect(cookie).not.toContain("Max-Age=604800");

    const preview = viewAsCookie("regular:view");
    expect(preview).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
  });

  it("still accepts a session that is weeks old and rejects one that has actually expired", async () => {
    const now = Math.floor(Date.now() / 1000);
    const aging = await tokenIssuedAt(emit, now - 20 * DAY);
    const read = await verifySessionToken(aging);
    expect(read?.email).toBe(emit.email);
    expect(read?.role).toBe("customer");
    expect(read?.passwordEpoch).toBe(3);

    const expired = await new SignJWT({ email: emit.email, name: emit.name, role: emit.role, pwd: 3 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(emit.userId)
      .setIssuedAt(now - 5 * 60 - 10)
      .setExpirationTime(now - 10)
      .sign(authSecret());
    expect(await verifySessionToken(expired)).toBeNull();
    expect(await rollingSessionCookie(expired)).toBeNull();
  });

  it("rolls a day-old session forward and leaves a fresh one alone", async () => {
    const now = Math.floor(Date.now() / 1000);
    expect(sessionNeedsRefresh(now - 60)).toBe(false);
    expect(sessionNeedsRefresh(now - SESSION_REFRESH_AFTER_SECONDS + 5, now)).toBe(false);
    expect(sessionNeedsRefresh(now - SESSION_REFRESH_AFTER_SECONDS, now)).toBe(true);
    expect(sessionNeedsRefresh(0, now)).toBe(true);

    expect(await rollingSessionCookie(await signSession(select))).toBeNull();

    const stale = await tokenIssuedAt(select, now - 2 * DAY);
    const renewed = await rollingSessionCookie(stale);
    expect(renewed).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    const next = renewed!.split(";")[0].replace("portal_session=", "");
    const claims = decodeJwt(next);
    expect(claims.exp! - claims.iat!).toBe(SESSION_MAX_AGE_SECONDS);
    expect(claims.iat!).toBeGreaterThan(now - 5);
    expect(claims.role).toBe("admin");
    expect(claims.pwd).toBe(1);
    expect(claims.sub).toBe(select.userId);
    const verified = await verifySessionToken(next);
    expect(verified?.role).toBe("admin");
    expect(verified?.passwordEpoch).toBe(1);
  });

  it("refreshes an old session on a page read and does not refresh a password change", async () => {
    const now = Math.floor(Date.now() / 1000);
    const fresh = await signSession(emit);
    const quiet = await middleware(
      new NextRequest("http://portal.test/", { headers: { cookie: cookieHeader(fresh) } }),
    );
    expect(quiet.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session="))).toBe(false);

    const stale = await tokenIssuedAt(emit, now - 2 * DAY);
    const refreshed = await middleware(
      new NextRequest("http://portal.test/orders/load-1", { headers: { cookie: cookieHeader(stale) } }),
    );
    const issued = refreshed.headers.getSetCookie().find((cookie) => cookie.startsWith("portal_session="));
    expect(issued).toBeTruthy();
    expect(issued).toContain(`Max-Age=${SESSION_MAX_AGE_SECONDS}`);
    expect(refreshed.headers.get("location")).toBeNull();

    const passwordChange = await middleware(
      new NextRequest("http://portal.test/api/me/password", {
        method: "POST",
        headers: { cookie: cookieHeader(stale) },
      }),
    );
    expect(passwordChange.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session="))).toBe(false);
  });

  it("keeps EMIT users out of Select admin pages and sends an expired session to sign in", async () => {
    const now = Math.floor(Date.now() / 1000);
    const customer = await tokenIssuedAt(emit, now - 2 * DAY);
    const blocked = await middleware(
      new NextRequest("http://portal.test/admin", { headers: { cookie: cookieHeader(customer) } }),
    );
    expect(blocked.status).toBeGreaterThanOrEqual(300);
    expect(blocked.status).toBeLessThan(400);
    expect(blocked.headers.get("location")).toBe("http://portal.test/");

    const api = await middleware(
      new NextRequest("http://portal.test/api/admin/users", { headers: { cookie: cookieHeader(customer) } }),
    );
    expect(api.status).toBe(403);

    const admin = await tokenIssuedAt(select, now - 2 * DAY);
    const allowed = await middleware(
      new NextRequest("http://portal.test/admin/users", { headers: { cookie: cookieHeader(admin) } }),
    );
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get("location")).toBeNull();
    expect(allowed.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session="))).toBe(true);

    const expired = await new SignJWT({ email: emit.email, name: emit.name, role: emit.role, pwd: 3 })
      .setProtectedHeader({ alg: "HS256" })
      .setSubject(emit.userId)
      .setIssuedAt(now - 6 * 60)
      .setExpirationTime(now - 60)
      .sign(authSecret());
    const signedOut = await middleware(
      new NextRequest("http://portal.test/", { headers: { cookie: cookieHeader(expired) } }),
    );
    expect(signedOut.status).toBeGreaterThanOrEqual(300);
    expect(signedOut.headers.get("location")).toBe("http://portal.test/login");
    expect(signedOut.headers.getSetCookie().some((cookie) => cookie.startsWith("portal_session="))).toBe(false);
  });

  it("does not time out receiver links or the public tracking page", () => {
    expect(isPublicPath("/r/example-token")).toBe(true);
    expect(isPublicPath("/track/example-token")).toBe(true);
    expect(isPublicPath("/api/r/example-token")).toBe(true);
    for (const file of ["lib/receivers.ts", "app/r/[token]/page.tsx", "app/track/[token]/page.tsx", "components/shell.tsx"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/countdown|session expires|idle timeout|auto-logout|autologout/i);
    }
    expect(readFileSync("components/shell.tsx", "utf8")).not.toMatch(/set(?:Timeout|Interval)\([\s\S]{0,120}logout/);
    const receivers = readFileSync("lib/receivers.ts", "utf8");
    expect(receivers).not.toMatch(/setExpirationTime|Max-Age|setTimeout|setInterval/);
    expect(stateCookie("nonce")).toContain("Max-Age=600");
    expect(stateCookie("nonce")).not.toContain("portal_session");
  });
});
