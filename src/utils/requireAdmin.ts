// src/utils/requireAdmin.ts — NextAuth 경로 제거. signed session만 허용.
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveAuthFromCookieStore } from "@/lib/auth";

export async function requireAdmin() {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth || auth.role !== "admin") {
    throw NextResponse.json({ error: "unauthorized" }, { status: 401 });
  }
  return auth;
}
