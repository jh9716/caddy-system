/**
 * Capacitor ↔ Kakao Android SDK bridge (JS).
 *
 * Native (Capacitor Android): KakaoNativeAuth.login() → memory accessToken
 *   → POST /api/auth/kakao/native-session → vh_session cookie.
 * Web/PWA: REST GET /api/auth/kakao/start (unchanged).
 *
 * Forbidden: localStorage, sessionStorage, logs, DB for the access token.
 */

import { KAKAO_NATIVE_SESSION_PATH } from "@/lib/kakaoNativeSession";

export const NATIVE_KAKAO_LOGIN_ENABLED = true;

export const KAKAO_NATIVE_PLUGIN_NAME = "KakaoNativeAuth";

export type KakaoNativeLoginResult = { accessToken: string };

export function shouldUseNativeKakaoLogin(input: {
  isNativePlatform: boolean;
}): boolean {
  return NATIVE_KAKAO_LOGIN_ENABLED === true && input.isNativePlatform === true;
}

export function restKakaoStartUrl(callbackUrl?: string | null): string {
  const qs = callbackUrl
    ? `?callbackUrl=${encodeURIComponent(callbackUrl)}`
    : "";
  return `/api/auth/kakao/start${qs}`;
}

export function nativeKakaoSessionRequestInit(
  accessToken: string,
  callbackUrl?: string | null
): {
  method: "POST";
  headers: { "Content-Type": "application/json" };
  credentials: "include";
  body: string;
} {
  const body: { accessToken: string; callbackUrl?: string } = { accessToken };
  if (callbackUrl) body.callbackUrl = callbackUrl;
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify(body),
  };
}

export type KakaoLoginFlowResult =
  | { mode: "rest"; startUrl: string }
  | { mode: "native"; href: string; role: string };

export async function runKakaoLogin(input: {
  isNativePlatform: boolean;
  callbackUrl: string | null;
  nativeLogin: () => Promise<KakaoNativeLoginResult>;
  exchangeSession: (
    accessToken: string,
    callbackUrl: string | null
  ) => Promise<{ role: string; href: string }>;
}): Promise<KakaoLoginFlowResult> {
  if (!shouldUseNativeKakaoLogin(input)) {
    return { mode: "rest", startUrl: restKakaoStartUrl(input.callbackUrl) };
  }
  const result = await input.nativeLogin();
  const accessToken = String(result?.accessToken ?? "").trim();
  if (!accessToken) {
    throw new Error("kakao_token");
  }
  try {
    const session = await input.exchangeSession(accessToken, input.callbackUrl);
    return { mode: "native", href: session.href, role: session.role };
  } finally {
    // accessToken is a local binding and is not written to web storage.
  }
}

export { KAKAO_NATIVE_SESSION_PATH };
