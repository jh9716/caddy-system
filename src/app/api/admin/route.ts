import { NextRequest, NextResponse } from "next/server";
import {
  applySessionCookies,
  clearSessionCookies,
} from "@/lib/sessionCookies";

/**
 * Legacy admin-password cookie endpoint → signed env admin session only.
 * Plain admin=1 is no longer accepted anywhere.
 */
export async function POST(req: NextRequest) {
  const { password } = await req.json();
  if (!password || password !== process.env.ADMIN_PASSWORD) {
    return NextResponse.json(
      { ok: false, message: "비밀번호가 올바르지 않습니다." },
      { status: 401 }
    );
  }

  const username =
    process.env.ADMIN_USER || process.env.ADMIN_USERNAME || "admin";
  const res = NextResponse.json({ ok: true });
  await applySessionCookies(res, req, {
    userId: null,
    username,
    role: "admin",
    sessionVersion: 0,
  });
  return res;
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearSessionCookies(res, req);
  return res;
}
