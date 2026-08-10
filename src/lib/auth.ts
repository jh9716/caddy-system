// src/lib/auth.ts
import { NextRequest, NextResponse } from "next/server";
import { getRoleFromCookies } from "@/lib/sessionCookies";

/**
 * 관리자 쿠키가 없으면 401을 반환합니다.
 * 사용법: const guard = requireAdmin(req); if (guard) return guard;
 */
export function requireAdmin(req: NextRequest): NextResponse | void {
  const role = getRoleFromCookies(req.cookies);
  if (role !== "admin") {
    return NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
}
