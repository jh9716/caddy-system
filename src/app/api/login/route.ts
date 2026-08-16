import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import {
  applySessionCookies,
  normalizeAppRole,
  type AppRole,
} from "@/lib/sessionCookies";
import { verifyUserPassword } from "@/lib/userPassword";

export const dynamic = "force-dynamic";

async function issueLoginSession(
  res: NextResponse,
  req: NextRequest,
  username: string,
  role: AppRole,
  userId: number | null,
  sessionVersion: number
) {
  await applySessionCookies(res, req, {
    userId,
    username,
    role,
    sessionVersion,
  });
}

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

  const ADMIN_USER =
    process.env.ADMIN_USER || process.env.ADMIN_USERNAME || "admin";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
  const CADDY_USER =
    process.env.CADDY_USER || process.env.CADDY_USERNAME || "caddy";
  const CADDY_PASSWORD = process.env.CADDY_PASSWORD || "";

  // 1) 환경변수 계정 (로컬/터널 테스트용) — uid null, sv 0
  if (username === ADMIN_USER && ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    const res = NextResponse.json({ ok: true, role: "admin" });
    await issueLoginSession(res, req, username, "admin", null, 0);
    return res;
  }
  if (username === CADDY_USER && CADDY_PASSWORD && password === CADDY_PASSWORD) {
    const res = NextResponse.json({ ok: true, role: "caddy" });
    await issueLoginSession(res, req, username, "caddy", null, 0);
    return res;
  }

  // 2) DB User 계정 (bcrypt)
  try {
    const user = await prisma.user.findUnique({ where: { username } });
    if (user) {
      const ok = await verifyUserPassword(password, user.password);
      if (ok) {
        const role = normalizeAppRole(user.role);
        if (!role) {
          return NextResponse.json(
            { error: "unauthorized", message: "로그인 실패" },
            { status: 401 }
          );
        }
        const res = NextResponse.json({ ok: true, role });
        await issueLoginSession(
          res,
          req,
          user.username,
          role,
          user.id,
          user.sessionVersion ?? 0
        );
        return res;
      }
    }
  } catch (e) {
    console.error("[POST /api/login] db auth error", e);
  }

  return NextResponse.json(
    { error: "unauthorized", message: "로그인 실패" },
    { status: 401 }
  );
}
