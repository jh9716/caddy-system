import { NextRequest, NextResponse } from "next/server";
import {
  authUnavailableResponse,
  isAuthStoreUnavailable,
  mustChangePasswordResponse,
  resolveAuthUser,
} from "@/lib/auth";
import { shouldForcePasswordChange } from "@/lib/passwordPolicy";
import { clearSessionCookies } from "@/lib/sessionCookies";

/**
 * Board-push routes only: unauth 401, logged-in non-admin 403.
 * Does not change global requireAdmin (which returns 401 for both).
 */
export async function requireBoardPushAdmin(
  req: NextRequest
): Promise<NextResponse | void> {
  let auth;
  try {
    auth = await resolveAuthUser(req);
  } catch (e) {
    if (isAuthStoreUnavailable(e)) return authUnavailableResponse();
    throw e;
  }
  if (!auth) {
    const res = NextResponse.json({ error: "unauthorized" }, { status: 401 });
    clearSessionCookies(res, req);
    return res;
  }
  if (auth.role !== "admin") {
    return NextResponse.json({ error: "forbidden" }, { status: 403 });
  }
  if (shouldForcePasswordChange(auth)) {
    return mustChangePasswordResponse();
  }
}
