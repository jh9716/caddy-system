import { NextRequest, NextResponse } from "next/server";
import { applySessionCookies } from "@/lib/sessionCookies";

export async function POST(req: NextRequest) {
  try {
    const { password } = await req.json();
    if (!password || password !== process.env.ADMIN_PASSWORD) {
      return NextResponse.json(
        { ok: false, error: "INVALID_PASSWORD" },
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
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e.message }, { status: 400 });
  }
}
