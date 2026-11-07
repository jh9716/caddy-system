import {
  chatInternalSecret,
  internalAuthHeaders,
} from "./internalAuth";
import {
  chatTokenSessionVersion,
  isSessionBoundChatToken,
  type ChatTokenClaims,
} from "./token";
import { classifySessionProbe, type SessionProbeResult } from "./openSocketRecheck";
import { isPreviewWorker, isRedirectResponse, nextAppExtraHeaders, nextAppFetchInit, nextAppUrl, type NextAppEnv } from "./nextApp";

export const CHAT_SESSION_CHECK_PATH = "/api/chat/session-check";
export const CHAT_SESSION_REVOKE_PATH = "/internal/session-revoke";
export const CHAT_SESSION_EPOCH_PATH = "/internal/session-epoch";
export const CHAT_ROOM_REVOKE_PATH = "/internal/revoke-user";
export const CHAT_ROOM_EVICT_PATH = "/internal/evict-members";
export const SESSION_CHECK_TIMEOUT_MS = 2500;

/**
 * Worker /ws WebSocket 업그레이드만: 진입부의 Next/DB session-check 를 생략한다.
 * ChatRoom.authorizeSocket 이 최종 session-check 를 수행한다.
 * Directory 와 HTTP(비업그레이드) /ws 프로브는 생략하지 않는다.
 * c679e51 확인서(DO authorizeSocket 생략) 와는 반대 방향이다.
 */
export function shouldSkipWorkerSessionCheck(
  pathname: string,
  upgradeHeader: string | null | undefined
): boolean {
  return pathname === "/ws" && String(upgradeHeader || "").toLowerCase() === "websocket";
}

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

/**
 * 이미 열린 소켓 재검증용(새 연결 gate 아님). assertChatSessionCurrent 와 달리 fail-open:
 * 명확한 폐기 응답만 "revoked", 그 외(장애·시간 초과·미설정·v1)는 "unknown"/"current".
 */
export async function probeChatSession(
  env: SessionCheckEnv,
  claims: ChatTokenClaims
): Promise<SessionProbeResult> {
  if (claims.v !== 2) return "current";
  if (!isSessionBoundChatToken(claims)) return "unknown";
  const sv = chatTokenSessionVersion(claims);
  if (sv == null) return "unknown";
  const url = nextSessionCheckUrl(env);
  const secret = chatInternalSecret(env);
  if (!url || !secret) return "unknown";
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
    // Preview 리다이렉트 = 판정 불가(unknown) → 소켓 유지, 재요청 없음.
    if (isPreviewWorker(env) && isRedirectResponse(res)) return "unknown";
    const body = await res.json().catch(() => null);
    return classifySessionProbe(res.status, body);
  } catch {
    return "unknown";
  }
}
