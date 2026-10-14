import { jwtVerify } from "jose";
import { NextResponse, type NextRequest } from "next/server";
import { authSecret, isPublicPath, safeNextPath } from "@/lib/session";

export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  if (isPublicPath(pathname)) return NextResponse.next();

  const token = req.cookies.get("portal_session")?.value;
  if (!token) return unauthenticated(req, pathname);

  try {
    const { payload } = await jwtVerify(token, authSecret());
    const adminPath = pathname.startsWith("/admin") || pathname.startsWith("/api/admin");
    if (adminPath && payload.role !== "admin") {
      if (pathname.startsWith("/api/")) {
        return NextResponse.json({ error: "Forbidden" }, { status: 403 });
      }
      return NextResponse.redirect(new URL("/", req.url));
    }
    return NextResponse.next();
  } catch {
    return unauthenticated(req, pathname);
  }
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
