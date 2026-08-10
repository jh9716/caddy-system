import { NextRequest, NextResponse } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "@/lib/prisma";
import { applySessionCookies, type AppRole } from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (!username || !password) {
    return NextResponse.json({ error: "아이디/비밀번호를 입력하세요." }, { status: 401 });
  }

  const ADMIN_USER = process.env.ADMIN_USER || process.env.ADMIN_USERNAME || "admin";
  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || "";
  const CADDY_USER = process.env.CADDY_USER || process.env.CADDY_USERNAME || "caddy";
  const CADDY_PASSWORD = process.env.CADDY_PASSWORD || "";

  let role: AppRole | null = null;

  // 1) 환경변수 계정 (로컬/터널 테스트용)
  if (username === ADMIN_USER && ADMIN_PASSWORD && password === ADMIN_PASSWORD) {
    role = "admin";
  } else if (username === CADDY_USER && CADDY_PASSWORD && password === CADDY_PASSWORD) {
    role = "caddy";
  } else {
    // 2) DB User 계정 (bcrypt) — caddy_local 시드 admin 등
    try {
      const user = await prisma.user.findUnique({ where: { username } });
      if (user) {
        const ok = await bcrypt.compare(password, user.password);
        if (ok) {
          const dbRole = String(user.role || "").toLowerCase();
          if (dbRole === "admin" || dbRole === "caddy") {
            role = dbRole;
          }
        }
      }
    } catch (e) {
      console.error("[POST /api/login] db auth error", e);
    }
  }

  if (!role) {
    return NextResponse.json({ error: "unauthorized", message: "로그인 실패" }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true, role });
  applySessionCookies(res, req, role, username);
  return res;
}
