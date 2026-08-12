import { NextRequest, NextResponse } from "next/server";
import {
  KAKAO_RETURN_COOKIE,
  KAKAO_STATE_COOKIE,
  buildKakaoAuthorizeUrl,
  buildKakaoRedirectUri,
  createOAuthState,
  getKakaoClientConfig,
  oauthCookieOptions,
  safeReturnPath,
} from "@/lib/kakaoOAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

/**
 * GET /api/auth/kakao/start
 * state 쿠키 설정 후 카카오 인가 화면으로 이동
 */
export async function GET(req: NextRequest) {
  const cfg = getKakaoClientConfig();
  if (!cfg) {
    const login = new URL("/login", req.url);
    login.searchParams.set("error", "kakao_config");
    return NextResponse.redirect(login);
  }

  const state = createOAuthState();
  const redirectUri = buildKakaoRedirectUri(req);
  const authorizeUrl = buildKakaoAuthorizeUrl({
    clientId: cfg.clientId,
    redirectUri,
    state,
  });

  const res = NextResponse.redirect(authorizeUrl);
  const cookieOpts = oauthCookieOptions(req);
  res.cookies.set(KAKAO_STATE_COOKIE, state, cookieOpts);

  const returnTo = safeReturnPath(req.nextUrl.searchParams.get("callbackUrl"));
  if (returnTo) {
    res.cookies.set(KAKAO_RETURN_COOKIE, returnTo, cookieOpts);
  } else {
    res.cookies.set(KAKAO_RETURN_COOKIE, "", { ...cookieOpts, maxAge: 0 });
  }

  return res;
}
