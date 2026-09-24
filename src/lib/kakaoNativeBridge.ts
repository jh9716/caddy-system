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

const SAFE_NATIVE_DIAGNOSTIC =
  /^kakao_native_(talk|account|token-empty): [A-Za-z0-9_.\-]+ \/ [A-Za-z0-9_./\-]+$/;

export function isSafeNativeKakaoDiagnostic(message: string): boolean {
  return SAFE_NATIVE_DIAGNOSTIC.test(message);
}

export const NATIVE_KAKAO_LOGIN_FAILED_MESSAGE =
  "카카오 로그인에 실패했습니다. 잠시 후 다시 시도해주세요.";

function readErrorField(error: unknown, key: "message" | "code"): string {
  if (!error || typeof error !== "object") return "";
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value.trim() : "";
}

/** Internal allowlisted diagnostic only. Never logs or returns secrets. */
export function readSafeNativeKakaoDiagnostic(error: unknown): string | null {
  const message = readErrorField(error, "message");
  return isSafeNativeKakaoDiagnostic(message) ? message : null;
}

/** Native Capacitor reject only. Web/PWA REST errors stay on query-code mapping. */
export function formatNativeKakaoBridgeError(error: unknown): string {
  const message = readErrorField(error, "message");
  const code = readErrorField(error, "code");
  if (code === "kakao_denied" || message === "kakao_denied") {
    return "카카오 로그인이 취소되었습니다.";
  }
  if (code === "kakao_config") {
    return "카카오 로그인 설정이 없습니다. 관리자에게 문의하세요.";
  }
  if (readSafeNativeKakaoDiagnostic(error)) {
    return NATIVE_KAKAO_LOGIN_FAILED_MESSAGE;
  }
  if (
    message &&
    message !== "kakao_token" &&
    !isSafeNativeKakaoDiagnostic(message) &&
    !/[&=?:]|Bearer|https?:|token/i.test(message)
  ) {
    return message;
  }
  return NATIVE_KAKAO_LOGIN_FAILED_MESSAGE;
}

export { KAKAO_NATIVE_SESSION_PATH };
