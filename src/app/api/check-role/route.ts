import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import { resolveAuthFromCookieStore } from "@/lib/auth";
import {
  clearSessionCookies,
  readSessionTokenFromCookies,
} from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await cookies();
  const auth = await resolveAuthFromCookieStore(store);
  if (!auth) {
    const res = NextResponse.json({ role: null });
    if (readSessionTokenFromCookies(store)) {
      clearSessionCookies(res);
    }
    return res;
  }
  return NextResponse.json({ role: auth.role });
}
