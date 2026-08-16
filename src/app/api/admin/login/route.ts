import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies } from "@/lib/sessionCookies";
import { getEnvOnlyAdmin } from "@/lib/envCredentials";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    const admin = getEnvOnlyAdmin();
    if (!admin || !password || password !== admin.password) {
      return NextResponse.json(
        { ok: false, error: "INVALID_PASSWORD" },
        { status: 401 }
      );
    }
    const res = NextResponse.json({ ok: true });
    await applySessionCookies(res, req, {
      userId: null,
      username: admin.username,
      role: "admin",
      sessionVersion: 0,
    });
    return res;
  } catch (e) {
    console.error("[POST /api/admin/login]", e);
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
}
