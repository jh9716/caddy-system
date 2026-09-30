import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySessionCookies } from "@/lib/sessionCookies";
import { passwordLogin } from "@/lib/passwordLogin";
import {
  passwordLoginRateLimitedResponse,
  passwordLoginUnauthorizedResponse,
} from "@/lib/passwordLoginHttp";
import {
  clearPasswordLoginFailures,
  loginRateIpFromRequest,
  readPasswordLoginRateLimit,
  recordPasswordLoginFailure,
} from "@/lib/passwordLoginRateLimit";

export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => ({}));
  const username = String(body?.username ?? "").trim();
  const password = String(body?.password ?? "");

  if (!username || !password) {
    return passwordLoginUnauthorizedResponse();
  }

  const ip = loginRateIpFromRequest(req);
  const limited = await readPasswordLoginRateLimit(prisma, { ip, username });
  if (limited.limited) {
    return passwordLoginRateLimitedResponse(limited.retryAfterSec);
  }

  const result = await passwordLogin(username, password, prisma);
  if (result.status === "unavailable") {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
  if (result.status !== "ok") {
    await recordPasswordLoginFailure(prisma, { ip, username });
    return passwordLoginUnauthorizedResponse();
  }

  await clearPasswordLoginFailures(prisma, { ip, username });

  try {
    const res = NextResponse.json({
      ok: true,
      role: result.role,
      mustChangePassword: result.mustChangePassword === true,
    });
    await applySessionCookies(res, req, {
      userId: result.userId,
      username: result.username,
      role: result.role,
      sessionVersion: result.sessionVersion,
    });
    return res;
  } catch (e) {
    console.error("[POST /api/login] session issue", e);
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
}
