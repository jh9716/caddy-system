import { NextResponse } from "next/server";
import { cookies } from "next/headers";
import {
  isAuthStoreUnavailable,
  resolveAuthFromCookieStore,
} from "@/lib/auth";
import {
  clearSessionCookies,
  readSessionTokenFromCookies,
} from "@/lib/sessionCookies";

export const dynamic = "force-dynamic";

export async function GET() {
  const store = await cookies();
  try {
    const auth = await resolveAuthFromCookieStore(store);
    if (!auth) {
      const res = NextResponse.json({ role: null });
      if (readSessionTokenFromCookies(store)) {
        clearSessionCookies(res);
      }
      return res;
    }
    return NextResponse.json({ role: auth.role });
  } catch (e) {
    if (isAuthStoreUnavailable(e)) {
      return NextResponse.json({ role: null }, { status: 503 });
    }
    throw e;
  }
}
