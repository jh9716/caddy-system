import { NextResponse } from "next/server";
import type { NextRequest } from "next/server";
import { getVerifiedSessionFromCookies } from "@/lib/sessionCookies";
import {
  isAccountManagerAuth,
} from "@/lib/staffAdminAccounts";

/**
 * Edge-safe gate only:
 * - signed vh_session required (legacy unsigned cookies ignored)
 * - signature + expiry + role claim
 * DB sessionVersion is enforced in Node requireAdmin / layouts / APIs.
 */
export async function middleware(req: NextRequest) {
  const { pathname } = req.nextUrl;
  const session = await getVerifiedSessionFromCookies(req.cookies);

  if (pathname === "/assignments" || pathname.startsWith("/assignments/")) {
    if (!session || session.role !== "admin") {
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
  }

  if (pathname === "/schedule" || pathname.startsWith("/schedule/")) {
    if (!session) {
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
    if (session.role !== "admin") {
      // 캐디/조장 실사용 배치는 /board. 추측으로 가용표 권한을 넓히지 않는다.
      const dest = req.nextUrl.clone();
      dest.pathname = "/board";
      dest.search = "";
      return NextResponse.redirect(dest);
    }
  }

  if (pathname.startsWith("/manage")) {
    if (!session || session.role !== "admin") {
      const login = req.nextUrl.clone();
      login.pathname = "/login";
      login.searchParams.set("callbackUrl", pathname);
      return NextResponse.redirect(login);
    }
    if (
      pathname.startsWith("/manage/staff-accounts") &&
      !isAccountManagerAuth({
        role: session.role,
        username: session.username,
        uid: session.uid,
      })
    ) {
      return NextResponse.json(
        {
          error: "forbidden",
          message: "최고관리자만 직원 계정을 관리할 수 있습니다.",
        },
        { status: 403 }
      );
    }
  }

  if (
    pathname.startsWith("/caddy") ||
    pathname.startsWith("/board") ||
    pathname.startsWith("/notice") ||
    pathname.startsWith("/course-reports") ||
    pathname.startsWith("/off-requests")
  ) {
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
  matcher: [
    "/manage/:path*",
    "/caddy/:path*",
    "/board/:path*",
    "/assignments",
    "/assignments/:path*",
    "/schedule",
    "/schedule/:path*",
    "/notice",
    "/notice/:path*",
    "/course-reports",
    "/course-reports/:path*",
    "/off-requests",
    "/off-requests/:path*",
  ],
};
