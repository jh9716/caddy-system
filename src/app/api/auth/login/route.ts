import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySessionCookies } from "@/lib/sessionCookies";
import { passwordLogin } from "@/lib/passwordLogin";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (!username || !password) {
    return NextResponse.json(
      { ok: false, message: "존재하지 않거나 권한이 없습니다." },
      { status: 401 }
    );
  }

  const result = await passwordLogin(username, password, prisma);
  if (result.status === "unavailable") {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
  if (result.status !== "ok") {
    const message =
      result.reason === "bad_password"
        ? "비밀번호가 올바르지 않습니다."
        : "존재하지 않거나 권한이 없습니다.";
    return NextResponse.json({ ok: false, message }, { status: 401 });
  }

  try {
    const res = NextResponse.json({
      ok: true,
      message: "로그인 성공",
      role: result.role,
    });
    await applySessionCookies(res, req, {
      userId: result.userId,
      username: result.username,
      role: result.role,
      sessionVersion: result.sessionVersion,
    });
    return res;
  } catch (e) {
    console.error("[POST /api/auth/login] session issue", e);
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
}
