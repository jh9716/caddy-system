import { NextRequest, NextResponse } from "next/server";
import { Prisma } from "@prisma/client";
import { prisma } from "@/lib/prisma";
import {
  applySessionCookies,
  normalizeAppRole,
  type AppRole,
} from "@/lib/sessionCookies";
import {
  KAKAO_RETURN_COOKIE,
  KAKAO_STATE_COOKIE,
  buildKakaoRedirectUri,
  exchangeKakaoAuthorizationCode,
  fetchKakaoUserId,
  getKakaoClientConfig,
  kakaoUsernameFromId,
  oauthCookieOptions,
  safeReturnPath,
  statesMatch,
} from "@/lib/kakaoOAuth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function redirectLoginError(req: NextRequest, code: string) {
  const login = new URL("/login", req.url);
  login.searchParams.set("error", code);
  const res = NextResponse.redirect(login);
  clearOAuthCookies(res, req);
  return res;
}

function clearOAuthCookies(res: NextResponse, req: NextRequest) {
  const opts = { ...oauthCookieOptions(req), maxAge: 0 };
  res.cookies.set(KAKAO_STATE_COOKIE, "", opts);
  res.cookies.set(KAKAO_RETURN_COOKIE, "", opts);
}

/**
 * GET /api/auth/kakao/callback
 * code → token → kakao id → User upsert → 기존 session cookie 발급
 */
export async function GET(req: NextRequest) {
  const cfg = getKakaoClientConfig();
  if (!cfg) return redirectLoginError(req, "kakao_config");

  const url = req.nextUrl;
  const err = url.searchParams.get("error");
  if (err) return redirectLoginError(req, "kakao_denied");

  const code = String(url.searchParams.get("code") ?? "").trim();
  const queryState = String(url.searchParams.get("state") ?? "").trim();
  const cookieState = req.cookies.get(KAKAO_STATE_COOKIE)?.value;

  if (!code || !statesMatch(cookieState, queryState)) {
    return redirectLoginError(req, "kakao_state");
  }

  const redirectUri = buildKakaoRedirectUri(req);
  let kakaoUserId: string;
  try {
    const { access_token } = await exchangeKakaoAuthorizationCode({
      clientId: cfg.clientId,
      clientSecret: cfg.clientSecret,
      code,
      redirectUri,
    });
    kakaoUserId = await fetchKakaoUserId(access_token);
  } catch (e) {
    console.error("[kakao/callback] token/userinfo", e);
    return redirectLoginError(req, "kakao_token");
  }

  let username: string;
  try {
    username = kakaoUsernameFromId(kakaoUserId);
  } catch {
    return redirectLoginError(req, "kakao_user");
  }

  let role: AppRole = "caddy";
  try {
    // Existing user: 1 User lookup. Caddy link is not needed to issue the session.
    let user = await prisma.user.findUnique({
      where: { kakaoUserId },
      select: {
        id: true,
        username: true,
        role: true,
        sessionVersion: true,
      },
    });

    if (!user) {
      try {
        user = await prisma.user.create({
          data: {
            username,
            password: null,
            role: "caddy",
            caddyId: null,
            managedTeams: [],
            kakaoUserId,
          },
          select: {
            id: true,
            username: true,
            role: true,
            sessionVersion: true,
          },
        });
      } catch (e) {
        // 동시 최초 로그인 레이스 → kakaoUserId unique
        if (
          e instanceof Prisma.PrismaClientKnownRequestError &&
          e.code === "P2002"
        ) {
          user = await prisma.user.findUnique({
            where: { kakaoUserId },
            select: {
              id: true,
              username: true,
              role: true,
              sessionVersion: true,
            },
          });
        } else {
          throw e;
        }
      }
    }

    if (!user) return redirectLoginError(req, "kakao_user");

    // 기존 User는 DB role 유지 (leader 등). 신규는 caddy.
    role = normalizeAppRole(user.role) || "caddy";
    username = user.username;

    const returnCookie = req.cookies.get(KAKAO_RETURN_COOKIE)?.value;
    const returnTo = safeReturnPath(returnCookie);
    const dest =
      returnTo || (role === "admin" ? "/manage" : "/caddy");

    const res = NextResponse.redirect(new URL(dest, req.url));
    clearOAuthCookies(res, req);
    await applySessionCookies(res, req, {
      userId: user.id,
      username: user.username,
      role,
      sessionVersion: user.sessionVersion ?? 0,
    });
    return res;
  } catch (e) {
    console.error("[kakao/callback] user upsert", e);
    return redirectLoginError(req, "kakao_user");
  }
}
