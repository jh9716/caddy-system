import {
  chatInternalSecret,
  internalAuthHeaders,
} from "./internalAuth";
import { isPreviewWorker, isRedirectResponse, nextAppExtraHeaders, nextAppFetchInit, nextAppUrl, type NextAppEnv } from "./nextApp";
import {
  chatTokenSessionVersion,
  isSessionBoundChatToken,
  type ChatTokenClaims,
} from "./token";

export const CHAT_SESSION_CHECK_PATH = "/api/chat/session-check";
export const CHAT_SESSION_REVOKE_PATH = "/internal/session-revoke";
export const CHAT_SESSION_EPOCH_PATH = "/internal/session-epoch";
export const CHAT_ROOM_REVOKE_PATH = "/internal/revoke-user";
export const CHAT_ROOM_EVICT_PATH = "/internal/evict-members";
export const SESSION_CHECK_TIMEOUT_MS = 2500;

export type SessionCheckEnv = NextAppEnv & {
  CHAT_AUTH_SECRET: string;
  CHAT_INTERNAL_SECRET?: string;
};

/** 운영: 기존과 동일하게 CHAT_PUSH_DISPATCH_URL 에서 유도. Preview: 검증된 Preview 호스트만 (아니면 ""). */
export function nextSessionCheckUrl(env: SessionCheckEnv): string {
  return nextAppUrl(env, CHAT_SESSION_CHECK_PATH);
}

export function parseSessionRevokeBody(raw: unknown): {
  userId: number;
  sessionVersion: number;
} | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { userId?: unknown; sessionVersion?: unknown };
  const userId = Number(rec.userId);
  const sessionVersion = Number(rec.sessionVersion);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Number.isInteger(sessionVersion) || sessionVersion < 0) return null;
  return { userId, sessionVersion };
}

export function parseEvictMembersBody(raw: unknown): { userIds: number[] } | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { userIds?: unknown };
  if (!Array.isArray(rec.userIds) || rec.userIds.length > 32) return null;
  const userIds: number[] = [];
  const seen = new Set<number>();
  for (const value of rec.userIds) {
    const userId = Number(value);
    if (!Number.isInteger(userId) || userId <= 0 || seen.has(userId)) continue;
    seen.add(userId);
    userIds.push(userId);
  }
  return { userIds };
}

export async function assertChatSessionCurrent(
  env: SessionCheckEnv,
  claims: ChatTokenClaims
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (claims.v !== 2) return { ok: true };
  if (!isSessionBoundChatToken(claims)) {
    return { ok: false, status: 401, error: "invalid_token" };
  }
  const sv = chatTokenSessionVersion(claims);
  if (sv == null) return { ok: false, status: 401, error: "stale_session" };
  const url = nextSessionCheckUrl(env);
  if (!url) return { ok: false, status: 503, error: "session_check_unconfigured" };
  const secret = chatInternalSecret(env);
  if (!secret) return { ok: false, status: 503, error: "session_check_unconfigured" };
  try {
    const headers = {
      ...(await internalAuthHeaders(secret, CHAT_SESSION_CHECK_PATH)),
      ...nextAppExtraHeaders(env, url),
    };
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: claims.userId, sv }),
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
      ...nextAppFetchInit(env),
    });
    // Preview: 리다이렉트는 따라가지 않고 실패(503) — 비밀 헤더가 다른 호스트로 가지 않게.
    if (isPreviewWorker(env) && isRedirectResponse(res)) {
      return { ok: false, status: 503, error: "session_check_unavailable" };
    }
    if (res.status === 503) {
      return { ok: false, status: 503, error: "session_check_unavailable" };
    }
    if (!res.ok) {
      return { ok: false, status: 401, error: "stale_session" };
    }
    const data = (await res.json()) as { ok?: boolean };
    if (data.ok !== true) {
      return { ok: false, status: 401, error: "stale_session" };
    }
    return { ok: true };
  } catch {
    return { ok: false, status: 503, error: "session_check_unavailable" };
  }
}
