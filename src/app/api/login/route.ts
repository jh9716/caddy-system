import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySessionCookies } from "@/lib/sessionCookies";
import { passwordLogin } from "@/lib/passwordLogin";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (!username || !password) {
    return NextResponse.json(
      { error: "아이디/비밀번호를 입력하세요." },
      { status: 401 }
    );
  }

  const result = await passwordLogin(username, password, prisma);
  if (result.status === "unavailable") {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
  if (result.status !== "ok") {
    return NextResponse.json(
      { error: "unauthorized", message: "로그인 실패" },
      { status: 401 }
    );
  }

  try {
    const res = NextResponse.json({ ok: true, role: result.role });
    await applySessionCookies(res, req, {
      userId: result.userId,
      username: result.username,
      role: result.role,
      sessionVersion: result.sessionVersion,
    });
    return res;
  } catch (e) {
    console.error("[POST /api/login] session issue", e);
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
}
