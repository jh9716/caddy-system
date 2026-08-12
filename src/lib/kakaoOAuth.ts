/**
 * 자체 Kakao OAuth 헬퍼 (NextAuth 미사용)
 * - identity: Kakao numeric user id → User.kakaoUserId (문자열)
 * - 이메일/닉네임/이름으로 User·Caddy 자동 병합 금지
 */

import { createHash, randomBytes, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";

export const KAKAO_STATE_COOKIE = "kakao_oauth_state";
export const KAKAO_RETURN_COOKIE = "kakao_oauth_return";
export const KAKAO_CALLBACK_PATH = "/api/auth/kakao/callback";

const STATE_MAX_AGE_SEC = 60 * 10; // 10m

export type KakaoClientConfig = {
  clientId: string;
  clientSecret: string;
};

export function getKakaoClientConfig(): KakaoClientConfig | null {
  const clientId = String(process.env.KAKAO_CLIENT_ID ?? "").trim();
  const clientSecret = String(process.env.KAKAO_CLIENT_SECRET ?? "").trim();
  if (!clientId || !clientSecret) return null;
  return { clientId, clientSecret };
}

/** 요청 host 기준 Redirect URI (Console 등록값과 일치해야 함) */
export function buildKakaoRedirectUri(req: NextRequest): string {
  const url = new URL(req.url);
  const forwardedHost = req.headers.get("x-forwarded-host")?.split(",")[0]?.trim();
  const host = forwardedHost || url.host;

  const forwardedProto = req.headers
    .get("x-forwarded-proto")
    ?.split(",")[0]
    ?.trim()
    .toLowerCase();
  let proto = forwardedProto || url.protocol.replace(":", "");
  if (process.env.VERCEL === "1" && proto !== "https") proto = "https";
  if (!proto) proto = "http";

  return `${proto}://${host}${KAKAO_CALLBACK_PATH}`;
}

export function buildKakaoAuthorizeUrl(input: {
  clientId: string;
  redirectUri: string;
  state: string;
}): string {
  const params = new URLSearchParams({
    client_id: input.clientId,
    redirect_uri: input.redirectUri,
    response_type: "code",
    state: input.state,
  });
  return `https://kauth.kakao.com/oauth/authorize?${params.toString()}`;
}

export function createOAuthState(): string {
  return randomBytes(24).toString("hex");
}

/** state 쿠키 값과 query state 비교 (timing-safe) */
export function statesMatch(
  cookieState: string | undefined | null,
  queryState: string | undefined | null
): boolean {
  const a = String(cookieState ?? "");
  const b = String(queryState ?? "");
  if (!a || !b || a.length !== b.length) return false;
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/** open redirect 방지: 같은 origin 상대 경로만 */
export function safeReturnPath(input: unknown): string | null {
  const raw = String(input ?? "").trim();
  if (!raw) return null;
  if (!raw.startsWith("/") || raw.startsWith("//")) return null;
  if (raw.includes("\\") || raw.includes("\n") || raw.includes("\r")) return null;
  return raw;
}

/** 카카오 id → 앱 username (닉네임 사용 금지) */
export function kakaoUsernameFromId(kakaoUserId: string): string {
  const id = String(kakaoUserId ?? "").trim();
  if (!/^\d+$/.test(id)) {
    throw new Error("invalid kakao user id");
  }
  return `kakao_${id}`;
}

export function normalizeKakaoUserId(raw: unknown): string | null {
  if (typeof raw === "number" && Number.isFinite(raw) && raw > 0) {
    return String(Math.trunc(raw));
  }
  const s = String(raw ?? "").trim();
  if (/^\d+$/.test(s)) return s;
  return null;
}

export async function exchangeKakaoAuthorizationCode(input: {
  clientId: string;
  clientSecret: string;
  code: string;
  redirectUri: string;
}): Promise<{ access_token: string }> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    client_id: input.clientId,
    client_secret: input.clientSecret,
    code: input.code,
    redirect_uri: input.redirectUri,
  });
  const res = await fetch("https://kauth.kakao.com/oauth/token", {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    body,
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as {
    access_token?: string;
    error?: string;
    error_description?: string;
  };
  if (!res.ok || !data.access_token) {
    throw new Error(
      data.error_description || data.error || "kakao_token_exchange_failed"
    );
  }
  return { access_token: data.access_token };
}

/**
 * /v2/user/me — id만 사용. profile/email은 identity로 쓰지 않음.
 */
export async function fetchKakaoUserId(accessToken: string): Promise<string> {
  const res = await fetch("https://kapi.kakao.com/v2/user/me", {
    method: "GET",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/x-www-form-urlencoded;charset=utf-8",
    },
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as { id?: unknown };
  if (!res.ok) {
    throw new Error("kakao_userinfo_failed");
  }
  const id = normalizeKakaoUserId(data.id);
  if (!id) throw new Error("kakao_user_id_missing");
  return id;
}

export function oauthCookieOptions(req: NextRequest, maxAge = STATE_MAX_AGE_SEC) {
  const secure =
    process.env.VERCEL === "1" ||
    req.nextUrl.protocol === "https:" ||
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() === "https";
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge,
  };
}

/** 테스트/디버그용: state 길이 해시 (비밀 아님) */
export function fingerprintState(state: string): string {
  return createHash("sha256").update(state).digest("hex").slice(0, 12);
}
