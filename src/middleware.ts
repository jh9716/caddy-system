import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";

/**
 * 관리 화면은 로그인(admin) 필수.
 * NextAuth middleware는 NEXTAUTH_URL(localhost) 고정 이슈가 있어
 * 쿠키 기반 role 가드를 사용한다 (Cloudflare 터널 호환).
 */
export function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const role =
    req.cookies.get("role")?.value ||
    req.cookies.get("session_role")?.value ||
    (req.cookies.get("admin")?.value === "1" ? "admin" : null);

  if (pathname.startsWith("/manage")) {
    if (role !== "admin") {
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
  }

  if (pathname.startsWith("/caddy")) {
    if (role !== "caddy" && role !== "admin") {
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
