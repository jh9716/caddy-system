import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { resolveAuthUser } from "@/lib/auth";
import { clearSessionCookies } from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/logout-all
 * Bump User.sessionVersion for the current signed DB user → invalidate all prior sessions.
 * Env-only accounts (no uid) cannot use this endpoint.
 */
export async function POST(req: NextRequest) {
  const auth = await resolveAuthUser(req);
  if (!auth) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    clearSessionCookies(res, req);
    return res;
  }

  if (auth.userId == null) {
    return NextResponse.json(
      {
        error: "logout_all_unavailable",
        message:
          "환경변수 계정은 원격 전체 로그아웃을 지원하지 않습니다. DB User로 로그인해주세요.",
      },
      { status: 400 }
    );
  }

  try {
    await prisma.user.update({
      where: { id: auth.userId },
      data: { sessionVersion: { increment: 1 } },
    });
  } catch (e) {
    console.error("[POST /api/auth/logout-all]", e);
    return NextResponse.json({ error: "update_failed" }, { status: 500 });
  }

  const res = NextResponse.json({
    ok: true,
    logoutAll: true,
    userId: auth.userId,
  });
  clearSessionCookies(res, req);
  return res;
}
