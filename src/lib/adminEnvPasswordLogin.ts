/**
 * Shared env-admin password POST for /api/admin and /api/admin/login.
 * Public, username-less: ADMIN_PASSWORD only. IP-only Audit limiter.
 */

import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySessionCookies } from "@/lib/sessionCookies";
import { getEnvOnlyAdmin } from "@/lib/envCredentials";
import {
  passwordLoginRateLimitedResponse,
  passwordLoginUnauthorizedResponse,
} from "@/lib/passwordLoginHttp";
import {
  ADMIN_ENV_PASSWORD_RATE_POLICY,
  ADMIN_ENV_PASSWORD_RATE_USERNAME,
  claimPasswordLoginAttempt,
  loginRateIpFromRequest,
  releasePasswordLoginClaim,
} from "@/lib/passwordLoginRateLimit";

export async function postAdminEnvPasswordLogin(
  req: NextRequest
): Promise<NextResponse> {
  const body = await req.json().catch(() => null);
  if (body == null || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "invalid_request" }, { status: 400 });
  }
  const password = String((body as { password?: unknown }).password ?? "");
  if (!password) {
    return passwordLoginUnauthorizedResponse();
  }

  const ip = loginRateIpFromRequest(req);
  const claim = await claimPasswordLoginAttempt(prisma, {
    ip,
    username: ADMIN_ENV_PASSWORD_RATE_USERNAME,
    policy: ADMIN_ENV_PASSWORD_RATE_POLICY,
  });
  if (claim.limited) {
    return passwordLoginRateLimitedResponse(claim.retryAfterSec);
  }

  const admin = getEnvOnlyAdmin();
  if (!admin || password !== admin.password) {
    return passwordLoginUnauthorizedResponse();
  }

  await releasePasswordLoginClaim(
    prisma,
    claim.claimId,
    ADMIN_ENV_PASSWORD_RATE_POLICY
  );

  try {
    const res = NextResponse.json({ ok: true });
    await applySessionCookies(res, req, {
      userId: null,
      username: admin.username,
      role: "admin",
      sessionVersion: 0,
    });
    return res;
  } catch (e) {
    console.error("[adminEnvPasswordLogin] session issue", e);
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
}
