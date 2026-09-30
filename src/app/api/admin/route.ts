import { NextRequest, NextResponse } from "next/server";
import { clearSessionCookies } from "@/lib/sessionCookies";
import { postAdminEnvPasswordLogin } from "@/lib/adminEnvPasswordLogin";

/**
 * Legacy admin-password cookie endpoint → signed env admin session only.
 * Plain admin=1 is no longer accepted anywhere.
 * Env-only admin requires ADMIN_PASSWORD to be set; no source default.
 */
export async function POST(req: NextRequest) {
  return postAdminEnvPasswordLogin(req);
}

export async function DELETE(req: NextRequest) {
  const res = NextResponse.json({ ok: true });
  clearSessionCookies(res, req);
  return res;
}
