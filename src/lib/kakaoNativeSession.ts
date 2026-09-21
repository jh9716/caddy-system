/**
 * Native Kakao Android SDK → vh_session exchange contract.
 *
 * App-only. Web/PWA keep REST `/api/auth/kakao/start` + `/callback`.
 * This module is the server-side design lock. The HTTP route is not
 * mounted in this step (no live Kakao login, no production User write).
 *
 * Flow (next implementation):
 *   native SDK OAuthToken
 *   → Capacitor bridge (memory only)
 *   → POST /api/auth/kakao/native-session { accessToken }
 *   → Kakao /v1/user/access_token_info (appId) + /v2/user/me (id)
 *   → User.kakaoUserId
 *   → applySessionCookies(vh_session)
 *
 * Forbidden: localStorage, logs, DB columns for the access token.
 * Forbidden: trusting client-supplied kakaoUserId.
 */

import {
  fetchKakaoUserId,
  kakaoUsernameFromId,
  normalizeKakaoUserId,
} from "@/lib/kakaoOAuth";
import { isRetiredCaddySessionBlocked } from "@/lib/auth";
import { normalizeAppRole, type AppRole } from "@/lib/sessionCookies";
import type { KakaoSessionUserRow } from "@/lib/kakaoSessionUser";
import { resolvePostLoginHref } from "@/lib/roleRouting";
import { safeReturnPath } from "@/lib/safeReturnPath";

export const KAKAO_NATIVE_SESSION_PATH = "/api/auth/kakao/native-session";
export const KAKAO_ACCESS_TOKEN_INFO_URL =
  "https://kapi.kakao.com/v1/user/access_token_info";
export const NATIVE_KAKAO_ACCESS_TOKEN_MAX_LEN = 4096;

export type NativeKakaoSessionParse =
  | { ok: true; accessToken: string }
  | {
      ok: false;
      error: "invalid_json" | "missing_token" | "client_kakao_id_not_trusted";
    };

export type KakaoAccessTokenInfo = {
  kakaoUserId: string;
  appId: string;
};

export type NativeKakaoSessionOk = {
  ok: true;
  userId: number;
  username: string;
  role: AppRole;
  sessionVersion: number;
  href: string;
};

export type NativeKakaoSessionFail = {
  ok: false;
  error:
    | "invalid_json"
    | "missing_token"
    | "client_kakao_id_not_trusted"
    | "kakao_config"
    | "kakao_token"
    | "kakao_user"
    | "kakao_retired";
};

export type NativeKakaoSessionResult =
  | NativeKakaoSessionOk
  | NativeKakaoSessionFail;

/** Numeric Kakao app id (console). Not the Native App Key string. */
export function getKakaoAppIdConfig(
  env: NodeJS.ProcessEnv = process.env
): string | null {
  const id = String(env.KAKAO_APP_ID ?? "").trim();
  return /^\d+$/.test(id) ? id : null;
}

/**
 * Only `accessToken` is accepted. A client `kakaoUserId` is a spoof attempt.
 */
export function parseNativeKakaoSessionBody(
  body: unknown
): NativeKakaoSessionParse {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return { ok: false, error: "invalid_json" };
  }
  const rec = body as Record<string, unknown>;
  if (Object.prototype.hasOwnProperty.call(rec, "kakaoUserId")) {
    return { ok: false, error: "client_kakao_id_not_trusted" };
  }
  if (typeof rec.accessToken !== "string") {
    return { ok: false, error: "missing_token" };
  }
  const accessToken = rec.accessToken.trim();
  if (
    !accessToken ||
    accessToken.length > NATIVE_KAKAO_ACCESS_TOKEN_MAX_LEN
  ) {
    return { ok: false, error: "missing_token" };
  }
  return { ok: true, accessToken };
}

export function parseKakaoAccessTokenInfo(
  data: unknown
): KakaoAccessTokenInfo | null {
  if (!data || typeof data !== "object") return null;
  const rec = data as { id?: unknown; appId?: unknown; app_id?: unknown };
  const kakaoUserId = normalizeKakaoUserId(rec.id);
  const appId = normalizeKakaoUserId(rec.appId ?? rec.app_id);
  if (!kakaoUserId || !appId) return null;
  return { kakaoUserId, appId };
}

export function kakaoAppIdMatches(
  tokenAppId: string,
  configuredAppId: string | null
): boolean {
  if (!configuredAppId) return false;
  return tokenAppId === configuredAppId;
}

export function kakaoBearerHeaders(accessToken: string): {
  Authorization: string;
} {
  return { Authorization: `Bearer ${accessToken}` };
}

export async function fetchKakaoAccessTokenInfo(
  accessToken: string
): Promise<KakaoAccessTokenInfo> {
  const res = await fetch(KAKAO_ACCESS_TOKEN_INFO_URL, {
    method: "GET",
    headers: kakaoBearerHeaders(accessToken),
    cache: "no-store",
  });
  const data = (await res.json().catch(() => ({}))) as unknown;
  if (!res.ok) throw new Error("kakao_tokeninfo_failed");
  const parsed = parseKakaoAccessTokenInfo(data);
  if (!parsed) throw new Error("kakao_tokeninfo_invalid");
  return parsed;
}

export type NativeKakaoSessionDeps = {
  configuredAppId: string | null;
  fetchTokenInfo: (accessToken: string) => Promise<KakaoAccessTokenInfo>;
  fetchUserId: (accessToken: string) => Promise<string>;
  findOrCreateUser: (kakaoUserId: string) => Promise<KakaoSessionUserRow | null>;
};

/**
 * Server exchange. Caller issues vh_session from the success payload.
 * Does not log, persist, or return the access token.
 */
export async function exchangeNativeKakaoSession(
  body: unknown,
  deps: NativeKakaoSessionDeps,
  callbackUrl?: unknown
): Promise<NativeKakaoSessionResult> {
  const parsed = parseNativeKakaoSessionBody(body);
  if (!parsed.ok) return parsed;

  if (!deps.configuredAppId) {
    return { ok: false, error: "kakao_config" };
  }

  let tokenInfo: KakaoAccessTokenInfo;
  let userMeId: string;
  try {
    tokenInfo = await deps.fetchTokenInfo(parsed.accessToken);
    userMeId = await deps.fetchUserId(parsed.accessToken);
  } catch {
    return { ok: false, error: "kakao_token" };
  }

  if (!kakaoAppIdMatches(tokenInfo.appId, deps.configuredAppId)) {
    return { ok: false, error: "kakao_token" };
  }
  if (tokenInfo.kakaoUserId !== userMeId) {
    return { ok: false, error: "kakao_token" };
  }

  try {
    kakaoUsernameFromId(userMeId);
  } catch {
    return { ok: false, error: "kakao_user" };
  }

  let user: KakaoSessionUserRow | null;
  try {
    user = await deps.findOrCreateUser(userMeId);
  } catch {
    return { ok: false, error: "kakao_user" };
  }
  if (!user) return { ok: false, error: "kakao_user" };

  const role = normalizeAppRole(user.role) || "caddy";
  if (
    isRetiredCaddySessionBlocked({
      role,
      caddyId: user.caddyId,
      employmentStatus: user.employmentStatus,
    })
  ) {
    return { ok: false, error: "kakao_retired" };
  }

  return {
    ok: true,
    userId: user.id,
    username: user.username,
    role,
    sessionVersion: user.sessionVersion,
    href: resolvePostLoginHref({
      role,
      callbackUrl: safeReturnPath(callbackUrl),
    }),
  };
}

/** Default live Kakao fetchers for the future route. Unused this step. */
export const liveNativeKakaoFetchers = {
  fetchTokenInfo: fetchKakaoAccessTokenInfo,
  fetchUserId: fetchKakaoUserId,
};
