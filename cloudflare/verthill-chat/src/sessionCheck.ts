import {
  chatInternalSecret,
  internalAuthHeaders,
} from "./internalAuth";
import {
  chatTokenSessionVersion,
  isChatTokenV2,
  type ChatTokenClaims,
} from "./token";

export const CHAT_SESSION_CHECK_PATH = "/api/chat/session-check";
export const CHAT_SESSION_REVOKE_PATH = "/internal/session-revoke";
export const CHAT_SESSION_EPOCH_PATH = "/internal/session-epoch";
export const CHAT_ROOM_REVOKE_PATH = "/internal/revoke-user";
export const SESSION_CHECK_TIMEOUT_MS = 2500;

export type SessionCheckEnv = {
  CHAT_AUTH_SECRET: string;
  CHAT_INTERNAL_SECRET?: string;
  CHAT_PUSH_DISPATCH_URL?: string;
};

export function nextSessionCheckUrl(env: SessionCheckEnv): string {
  const pushUrl = String(env.CHAT_PUSH_DISPATCH_URL || "").trim();
  if (!pushUrl) return "";
  try {
    const parsed = new URL(pushUrl);
    parsed.pathname = CHAT_SESSION_CHECK_PATH;
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "";
  }
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

export async function assertChatSessionCurrent(
  env: SessionCheckEnv,
  claims: ChatTokenClaims
): Promise<{ ok: true } | { ok: false; status: number; error: string }> {
  if (!isChatTokenV2(claims)) return { ok: true };
  const sv = chatTokenSessionVersion(claims);
  if (sv == null) return { ok: false, status: 401, error: "stale_session" };
  const url = nextSessionCheckUrl(env);
  if (!url) return { ok: false, status: 503, error: "session_check_unconfigured" };
  const secret = chatInternalSecret(env);
  if (!secret) return { ok: false, status: 503, error: "session_check_unconfigured" };
  try {
    const headers = await internalAuthHeaders(secret, CHAT_SESSION_CHECK_PATH);
    const res = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify({ userId: claims.userId, sv }),
      signal: AbortSignal.timeout(SESSION_CHECK_TIMEOUT_MS),
    });
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
