import { NextRequest, NextResponse } from "next/server";
import {
  applySessionCookies,
  clearSessionCookies,
} from "@/lib/sessionCookies";
import { getEnvOnlyAdmin } from "@/lib/envCredentials";

/**
 * Legacy admin-password cookie endpoint → signed env admin session only.
 * Plain admin=1 is no longer accepted anywhere.
 * Env-only admin requires ADMIN_PASSWORD to be set; no source default.
 */
export async function POST(req: NextRequest) {
  const { password } = await req.json().catch(() => ({}));
  const admin = getEnvOnlyAdmin();
  if (!admin || !password || password !== admin.password) {
    return NextResponse.json(
      { ok: false, message: "비밀번호가 올바르지 않습니다." },
      { status: 401 }
    );
  }

  try {
    const res = NextResponse.json({ ok: true });
    await applySessionCookies(res, req, {
      userId: null,
      username: admin.username,
      role: "admin",
      sessionVersion: 0,
    });
    return res;
  } catch (e) {
    console.error("[POST /api/admin]", e);
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearSessionCookies(res, req);
  return res;
}
