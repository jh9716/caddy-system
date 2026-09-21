import { NextRequest, NextResponse } from "next/server";
import { prisma } from "@/lib/prisma";
import { applySessionCookies } from "@/lib/sessionCookies";
import { findOrCreateKakaoSessionUser } from "@/lib/kakaoSessionUser";
import {
  exchangeNativeKakaoSession,
  getKakaoAppIdConfig,
  liveNativeKakaoFetchers,
  nativeKakaoSessionHttpStatus,
} from "@/lib/kakaoNativeSession";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * POST /api/auth/kakao/native-session
 * Body: { accessToken, callbackUrl? }
 * Client kakaoUserId is never trusted.
 * Does not log or persist the access token.
 */
export async function POST(req: NextRequest) {
  const body = await req.json().catch(() => null);
  const callbackUrl =
    body && typeof body === "object" && !Array.isArray(body)
      ? (body as { callbackUrl?: unknown }).callbackUrl
      : undefined;

  let result;
  try {
    result = await exchangeNativeKakaoSession(
      body,
      {
        configuredAppId: getKakaoAppIdConfig(),
        fetchTokenInfo: liveNativeKakaoFetchers.fetchTokenInfo,
        fetchUserId: liveNativeKakaoFetchers.fetchUserId,
        findOrCreateUser: (kakaoUserId) =>
          findOrCreateKakaoSessionUser(prisma, kakaoUserId),
      },
      callbackUrl
    );
  } catch {
    return NextResponse.json({ error: "kakao_user" }, { status: 400 });
  }

  if (!result.ok) {
    return NextResponse.json(
      { error: result.error },
      { status: nativeKakaoSessionHttpStatus(result.error) }
    );
  }

  try {
    const res = NextResponse.json({
      ok: true,
      role: result.role,
      href: result.href,
    });
    await applySessionCookies(res, req, {
      userId: result.userId,
      username: result.username,
      role: result.role,
      sessionVersion: result.sessionVersion,
    });
    return res;
  } catch {
    return NextResponse.json({ error: "auth_unavailable" }, { status: 500 });
  }
}
