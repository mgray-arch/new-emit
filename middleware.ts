import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { VIEW_AS_COOKIE, authSecret, isPublicPath, parseViewAs, rollingSessionCookie, safeNextPath } from "@/lib/session";

/** This route replaces the session cookie itself. A refresh here would race that write. */
const SESSION_WRITE_PATH = "/api/me/password";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = req.cookies.get("portal_session")?.value;
  if (!token) return unauthenticated(req, pathname);

  try {
    const { payload } = await jwtVerify(token, authSecret());
    const response = gate(req, pathname, payload.role);
    if (pathname !== SESSION_WRITE_PATH) {
      const renewed = await rollingSessionCookie(token);
      if (renewed) response.headers.append("set-cookie", renewed);
    }
    return response;
  } catch {
    return unauthenticated(req, pathname);
  }
}

function gate(req: NextRequest, pathname: string, role: unknown): NextResponse {
  const previewing = parseViewAs(req.cookies.get(VIEW_AS_COOKIE)?.value) !== null;
  const adminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
  if (previewing && adminPath && role === "admin") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", req.url));
  }
  if (adminPath && role !== "admin") {
    if (pathname.startsWith("/api/")) {
      return NextResponse.json({ error: "Forbidden" }, { status: 403 });
    }
    return NextResponse.redirect(new URL("/", req.url));
  }
  return NextResponse.next();
}

function unauthenticated(req: NextRequest, pathname: string) {
  if (pathname.startsWith("/api/")) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }
  const url = req.nextUrl.clone();
  url.pathname = "/login";
  url.search = "";
  if (pathname !== "/") url.searchParams.set("next", safeNextPath(pathname));
  return NextResponse.redirect(url);
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|brand/|favicon.ico|icon.png).*)"],
};
