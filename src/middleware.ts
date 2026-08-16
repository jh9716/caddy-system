import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";

/**
 * Edge-safe gate only:
 * - signed vh_session required (legacy unsigned cookies ignored)
 * - signature + expiry + role claim
 * DB sessionVersion is enforced in Node requireAdmin / layouts / APIs.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await getVerifiedSessionFromCookies(req.cookies);

  if (pathname.startsWith("/manage")) {
    if (!session || session.role !== "admin") {
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
  }

  if (pathname.startsWith("/caddy")) {
    if (
      !session ||
      (session.role !== "caddy" &&
        session.role !== "admin" &&
        session.role !== "leader")
    ) {
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
  }

  return NextResponse.next();
}

export const config = {
  matcher: ["/manage/:path*", "/caddy/:path*"],
};
