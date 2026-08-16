/**
 * Legacy path — do not use NextAuth. Prefer @/lib/auth requireAdmin(req).
 * Kept fail-closed for any stray imports.
 */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { resolveAuthFromCookieStore } from "@/lib/auth";

type GuardFail = { ok: false; status: 401 | 403 };
type GuardOk = { ok: true; role: "admin" };

export async function requireAdmin(): Promise<GuardOk | GuardFail> {
  const auth = await resolveAuthFromCookieStore(await cookies());
  if (!auth) return { ok: false, status: 401 };
  if (auth.role !== "admin") return { ok: false, status: 403 };
  return { ok: true, role: "admin" };
}

export function adminGuardResponse(result: GuardFail) {
  return NextResponse.json(
    { error: result.status === 403 ? "forbidden" : "unauthorized" },
    { status: result.status }
  );
}
