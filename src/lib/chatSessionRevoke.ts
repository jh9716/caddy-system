/**
 * Best-effort Worker fanout after User.sessionVersion increments.
 * New WS/directory connections do NOT depend on this — they re-check Next.
 * This only closes already-open sockets sooner than token exp.
 */

import { chatHttpBaseUrl } from "@/lib/chatClientConfig";
import {
  CHAT_INTERNAL_AUTH_HEADER,
  CHAT_INTERNAL_TS_HEADER,
  chatInternalSecret,
  signChatInternalAuth,
} from "@/lib/chatInternalAuth";
import { parseChatSessionEpoch } from "@/lib/chatSessionEpoch";

export const CHAT_SESSION_CHECK_PATH = "/api/chat/session-check";
export const CHAT_SESSION_REVOKE_PATH = "/internal/session-revoke";
export const CHAT_SESSION_REVOKE_TIMEOUT_MS = 2500;

export type ChatSessionRevokeNotifyResult = "ok" | "skipped" | "failed";

/** 재시도: 네트워크 오류·시간 초과·5xx·429 만. 그 외 4xx(서명·설정 문제)는 재시도해도 같으므로 즉시 실패. */
export const CHAT_SESSION_REVOKE_MAX_ATTEMPTS = 3;
export const CHAT_SESSION_REVOKE_BACKOFF_MS = [250, 750] as const;
/** 여러 계정 동시 알림 수(일괄 퇴사). */
export const CHAT_SESSION_REVOKE_CONCURRENCY = 4;
/**
 * 한 계정 알림 전체 시간 상한(재시도 포함). 로그아웃·비밀번호 변경 등 요청 경로를 오래 붙잡지 않도록
 * 기존 단일 시간 제한(2.5초)에 1초만 더한다. 응답 없는 Worker 는 첫 시도에서 대부분 소진 → 짧은 재시도 1회 정도.
 */
export const CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS = CHAT_SESSION_REVOKE_TIMEOUT_MS + 1000;
const MIN_ATTEMPT_MS = 300;

export function isRetryableRevokeStatus(status: number | null): boolean {
  if (status == null) return true; // 네트워크 오류·시간 초과
  return status === 429 || status >= 500;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function notifyChatSessionRevoked(
  input: { userId: number; sessionVersion: number },
  env: NodeJS.ProcessEnv = process.env
): Promise<ChatSessionRevokeNotifyResult> {
  const userId = Number(input.userId);
  const sessionVersion = parseChatSessionEpoch(input.sessionVersion);
  if (!Number.isInteger(userId) || userId <= 0 || sessionVersion == null) {
    return "skipped";
  }
  const worker = chatHttpBaseUrl();
  const secret = chatInternalSecret(env);
  if (!worker || !secret) return "skipped";
  // Worker 는 같은 사용자에 대해 max(sessionVersion) 만 기억하므로 재시도·중복 전송은 안전(되돌림 없음).
  let lastStatus: number | null = null;
  const deadline = Date.now() + CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS;
  for (let attempt = 1; attempt <= CHAT_SESSION_REVOKE_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 1 && remaining < MIN_ATTEMPT_MS) break;
    lastStatus = await postSessionRevoke(
      worker,
      secret,
      userId,
      sessionVersion,
      Math.max(MIN_ATTEMPT_MS, Math.min(CHAT_SESSION_REVOKE_TIMEOUT_MS, remaining))
    );
    if (lastStatus !== null && lastStatus >= 200 && lastStatus < 300) return "ok";
    if (!isRetryableRevokeStatus(lastStatus)) break;
    if (attempt < CHAT_SESSION_REVOKE_MAX_ATTEMPTS) {
      const wait = CHAT_SESSION_REVOKE_BACKOFF_MS[attempt - 1] ?? 750;
      if (deadline - Date.now() - wait < MIN_ATTEMPT_MS) break;
      await sleep(wait);
    }
  }
  // 조용히 무시하지 않음: 식별자 없이 상태만 기록. 새 연결은 DB 확인으로 이미 차단, 열린 소켓은 토큰 만료까지 남을 수 있음.
  console.error(
    `[chat-session-revoke] notify failed status=${lastStatus === null ? "network" : lastStatus}`
  );
  return "failed";
}

async function postSessionRevoke(
  worker: string,
  secret: string,
  userId: number,
  sessionVersion: number,
  timeoutMs: number
): Promise<number | null> {
  const ts = Math.floor(Date.now() / 1000);
  try {
    const res = await fetch(`${worker}${CHAT_SESSION_REVOKE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CHAT_INTERNAL_TS_HEADER]: String(ts),
        [CHAT_INTERNAL_AUTH_HEADER]: await signChatInternalAuth(
          secret,
          CHAT_SESSION_REVOKE_PATH,
          ts
        ),
      },
      body: JSON.stringify({ userId, sessionVersion }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.status;
  } catch {
    return null;
  }
}

export async function notifyChatSessionRevokedForUser(
  db: {
    user: {
      findUnique: (args: {
        where: { id: number };
        select: { id: true; sessionVersion: true };
      }) => Promise<{ id: number; sessionVersion: number } | null>;
    };
  },
  userId: number
): Promise<ChatSessionRevokeNotifyResult> {
  if (!Number.isInteger(userId) || userId <= 0) return "skipped";
  try {
    const row = await db.user.findUnique({
      where: { id: userId },
      select: { id: true, sessionVersion: true },
    });
    if (!row) return "skipped";
    return notifyChatSessionRevoked({
      userId: row.id,
      sessionVersion: row.sessionVersion,
    });
  } catch {
    return "failed";
  }
}

export async function notifyChatSessionRevokedForCaddyLink(
  db: {
    user: {
      findMany: (args: {
        where: { caddyId: number };
        select: { id: true; sessionVersion: true };
      }) => Promise<Array<{ id: number; sessionVersion: number }>>;
    };
  },
  caddyId: number
): Promise<ChatSessionRevokeNotifyResult[]> {
  if (!Number.isInteger(caddyId) || caddyId < 1) return [];
  try {
    const rows = await db.user.findMany({
      where: { caddyId },
      select: { id: true, sessionVersion: true },
    });
    const out: ChatSessionRevokeNotifyResult[] = [];
    for (const row of rows) {
      out.push(
        await notifyChatSessionRevoked({
          userId: row.id,
          sessionVersion: row.sessionVersion,
        })
      );
    }
    return out;
  } catch {
    return ["failed"];
  }
}

/**
 * 여러 캐디(일괄 퇴사)의 연결 계정에 폐기 알림. 커밋 이후 호출. 동시 CHAT_SESSION_REVOKE_CONCURRENCY 개.
 * 알림 시점의 최신 sessionVersion 을 읽어 보낸다(Worker 는 max 로 기억 → 중복·순서 뒤바뀜에도 되돌림 없음).
 */
export async function notifyChatSessionRevokedForCaddyLinks(
  db: {
    user: {
      findMany: (args: {
        where: { caddyId: { in: number[] } };
        select: { id: true; sessionVersion: true };
      }) => Promise<Array<{ id: number; sessionVersion: number }>>;
    };
  },
  caddyIds: number[]
): Promise<ChatSessionRevokeNotifyResult[]> {
  const ids = Array.from(new Set(caddyIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return [];
  let rows: Array<{ id: number; sessionVersion: number }>;
  try {
    rows = await db.user.findMany({
      where: { caddyId: { in: ids } },
      select: { id: true, sessionVersion: true },
    });
  } catch {
    console.error("[chat-session-revoke] notify lookup failed");
    return ["failed"];
  }
  const out: ChatSessionRevokeNotifyResult[] = [];
  for (let i = 0; i < rows.length; i += CHAT_SESSION_REVOKE_CONCURRENCY) {
    const chunk = rows.slice(i, i + CHAT_SESSION_REVOKE_CONCURRENCY);
    out.push(
      ...(await Promise.all(
        chunk.map((row) =>
          notifyChatSessionRevoked({ userId: row.id, sessionVersion: row.sessionVersion })
        )
      ))
    );
  }
  return out;
}
