/**
 * Capacitor ↔ Kakao Android SDK bridge contract (JS side).
 *
 * Native login is OFF this step. LoginClient keeps REST
 * `/api/auth/kakao/start`. Do not auto-run KakaoTalk / KakaoAccount.
 *
 * Next implementation:
 *   KakaoNativeAuth.login()
 *     → loginWithKakaoTalk() then loginWithKakaoAccount()
 *     → return { accessToken } in memory
 *     → POST /api/auth/kakao/native-session credentials:include
 *     → drop the token; never localStorage
 */

import { KAKAO_NATIVE_SESSION_PATH } from "@/lib/kakaoNativeSession";

/** Hard off until Kakao Developers registration + SDK wiring. */
export const NATIVE_KAKAO_LOGIN_ENABLED = false;

export const KAKAO_NATIVE_PLUGIN_NAME = "KakaoNativeAuth";

export type KakaoNativeLoginResult = { accessToken: string };

export function shouldUseNativeKakaoLogin(input: {
  isNativePlatform: boolean;
}): boolean {
  return NATIVE_KAKAO_LOGIN_ENABLED === true && input.isNativePlatform === true;
}

export function nativeKakaoSessionRequestInit(accessToken: string): {
  method: "POST";
  headers: { "Content-Type": "application/json" };
  credentials: "include";
  body: string;
} {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    credentials: "include",
    body: JSON.stringify({ accessToken }),
  };
}

export { KAKAO_NATIVE_SESSION_PATH };
