// src/utils/requireAdmin.ts — NextAuth 경로 제거. signed session만 허용.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveAuthFromCookieStore } from "@/lib/auth";

export async function requireAdmin() {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth || auth.role !== "admin") {
    throw NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  if (auth.mustChangePassword) {
    throw NextResponse.json(
      {
        error: "MUST_CHANGE_PASSWORD",
        message: "비밀번호를 변경한 뒤 이용할 수 있습니다.",
      },
      { status: 403 }
    );
  }
  return auth;
}
