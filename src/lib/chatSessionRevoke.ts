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
  let worker: string | null | undefined;
  let secret: string | null | undefined;
  try {
    // 설정 해석 자체가 throw 할 수 있으므로 try 안에서(값은 출력하지 않음).
    worker = chatHttpBaseUrl();
    secret = chatInternalSecret(env);
  } catch {
    console.error("[chat-session-revoke] notify config error");
    return "failed";
  }
  if (!worker || !secret) {
    // 설정 값은 출력하지 않음. 전송 안 됨 = 성공 아님(호출부가 skipped 로 구분).
    console.warn("[chat-session-revoke] notify not configured");
    return "skipped";
  }
  // Worker 는 같은 사용자에 대해 max(sessionVersion) 만 기억하므로 재시도·중복 전송은 안전(되돌림 없음).
  // 성공 = Worker 가 2xx 로 "Directory epoch + Directory 소켓 + 대상 Room 전부" 확인(status=ok).
  // Worker 502(partial)/503(failed) 는 성공 아님 → 재시도, 소진 시 failed.
  let lastStatus: number | null = null;
  let last: RevokeAttempt | null = null;
  let attempts = 0;
  const startedAt = Date.now();
  const deadline = startedAt + CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS;
  for (let attempt = 1; attempt <= CHAT_SESSION_REVOKE_MAX_ATTEMPTS; attempt++) {
    const remaining = deadline - Date.now();
    if (attempt > 1 && remaining < MIN_ATTEMPT_MS) break;
    attempts = attempt;
    last = await postSessionRevoke(
      worker,
      secret,
      userId,
      sessionVersion,
      Math.max(MIN_ATTEMPT_MS, Math.min(CHAT_SESSION_REVOKE_TIMEOUT_MS, remaining))
    );
    lastStatus = last.status;
    if (last.ok) return "ok";
    // 식별자·URL·토큰·오류 원문 없이 진단 필드만.
    console.warn(
      `[chat-session-revoke] attempt failed ${formatRevokeAttemptDiag(last, attempt)}`
    );
    if (!isRetryableRevokeStatus(lastStatus)) break;
    if (attempt < CHAT_SESSION_REVOKE_MAX_ATTEMPTS) {
      const wait = CHAT_SESSION_REVOKE_BACKOFF_MS[attempt - 1] ?? 750;
      if (deadline - Date.now() - wait < MIN_ATTEMPT_MS) break;
      await sleep(wait);
    }
  }
  // 조용히 무시하지 않음: 식별자 없이 상태만 기록. 새 연결은 DB 확인으로 이미 차단, 열린 소켓은 토큰 만료까지 남을 수 있음.
  console.error(
    `[chat-session-revoke] notify failed status=${lastStatus === null ? "network" : lastStatus} attempts=${attempts} totalMs=${Date.now() - startedAt}${last ? ` last=(${formatRevokeAttemptDiag(last, attempts)})` : ""}`
  );
  return "failed";
}

/** 한 번의 revoke POST 결과(진단 필드는 모두 분류된 값·숫자만; 식별자·URL·원문 없음). */
export type RevokeAttempt = {
  ok: boolean;
  status: number | null;
  stage: "sign" | "fetch" | "response";
  elapsedMs: number;
  errName?: string;
  abort?: "abort" | "timeout" | "no";
  causeCode?: string;
  workerStatus?: "ok" | "partial" | "failed" | "unknown";
  rooms?: { ok: number; total: number };
};

const SAFE_CODE_RE = /^[A-Z][A-Z0-9_]{1,47}$/;
const SAFE_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,47}$/;

/**
 * err.cause.code 만 안전하게 분류(DOMException 의 숫자 err.code 는 보지 않음). 추측하지 않는다:
 * cause/code 없음 → "none", 대문자/숫자/밑줄 형식이 아니면(호스트·경로 등이 섞일 수 있음) → "unknown".
 */
export function classifyRevokeCauseCode(err: unknown): string {
  const e = err as { cause?: { code?: unknown } } | null;
  const code = e?.cause && typeof e.cause === "object" ? e.cause.code : undefined;
  if (code == null || code === "") return "none";
  return typeof code === "string" && SAFE_CODE_RE.test(code) ? code : "unknown";
}

export function classifyRevokeError(err: unknown): Pick<RevokeAttempt, "errName" | "abort" | "causeCode"> {
  const rawName = (err as { name?: unknown } | null)?.name;
  const errName = typeof rawName === "string" && SAFE_NAME_RE.test(rawName) ? rawName : "unknown";
  const abort = errName === "AbortError" ? "abort" : errName === "TimeoutError" ? "timeout" : "no";
  return { errName, abort, causeCode: classifyRevokeCauseCode(err) };
}

export function formatRevokeAttemptDiag(a: RevokeAttempt, attempt: number): string {
  const parts = [
    `stage=${a.stage}`,
    `attempt=${attempt}/${CHAT_SESSION_REVOKE_MAX_ATTEMPTS}`,
    `elapsedMs=${Math.max(0, Math.round(a.elapsedMs))}`,
    `status=${a.status === null ? "network" : a.status}`,
  ];
  if (a.errName) parts.push(`err=${a.errName}`);
  if (a.abort) parts.push(`abort=${a.abort}`);
  if (a.causeCode) parts.push(`cause=${a.causeCode}`);
  if (a.workerStatus) parts.push(`worker=${a.workerStatus}`);
  if (a.rooms) parts.push(`rooms=${a.rooms.ok}/${a.rooms.total}`);
  return parts.join(" ");
}

function toCount(v: unknown): number {
  const n = Number(v);
  return Number.isInteger(n) && n >= 0 && n < 1_000_000 ? n : 0;
}

async function postSessionRevoke(
  worker: string,
  secret: string,
  userId: number,
  sessionVersion: number,
  timeoutMs: number
): Promise<RevokeAttempt> {
  const t0 = Date.now();
  const ts = Math.floor(t0 / 1000);
  let auth: string;
  try {
    auth = await signChatInternalAuth(secret, CHAT_SESSION_REVOKE_PATH, ts);
  } catch (err) {
    return { ok: false, status: null, stage: "sign", elapsedMs: Date.now() - t0, ...classifyRevokeError(err) };
  }
  let res: Response;
  try {
    res = await fetch(`${worker}${CHAT_SESSION_REVOKE_PATH}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        [CHAT_INTERNAL_TS_HEADER]: String(ts),
        [CHAT_INTERNAL_AUTH_HEADER]: auth,
      },
      body: JSON.stringify({ userId, sessionVersion }),
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { ok: false, status: null, stage: "fetch", elapsedMs: Date.now() - t0, ...classifyRevokeError(err) };
  }
  // 응답 본문은 분류용 enum·숫자만 읽는다(구 Worker 는 {ok:true} 만 → 2xx 면 성공으로 유지).
  const body = (await res.json().catch(() => null)) as {
    status?: unknown;
    rooms?: { ok?: unknown; total?: unknown };
  } | null;
  const ws = body?.status;
  const workerStatus =
    ws === "ok" || ws === "partial" || ws === "failed" ? ws : body ? "unknown" : undefined;
  const rooms =
    body?.rooms && typeof body.rooms === "object"
      ? { ok: toCount(body.rooms.ok), total: toCount(body.rooms.total) }
      : undefined;
  const is2xx = res.status >= 200 && res.status < 300;
  // 2xx 라도 Worker 가 partial/failed 라고 하면 성공 아님(재시도 대상: 5xx 처럼 취급).
  const notOkBody = workerStatus === "partial" || workerStatus === "failed";
  return {
    ok: is2xx && !notOkBody,
    status: is2xx && notOkBody ? 502 : res.status,
    stage: "response",
    elapsedMs: Date.now() - t0,
    workerStatus,
    rooms,
  };
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

import type { ChatRevokeBulkStatus, ChatRevokeBulkSummary } from "@/lib/chatRevokeSummary";
export type { ChatRevokeBulkStatus, ChatRevokeBulkSummary } from "@/lib/chatRevokeSummary";
export { chatRevokePendingCount, chatRevokePendingSuffix } from "@/lib/chatRevokeSummary";

export const CHAT_SESSION_REVOKE_BULK_CONCURRENCY = 8;

export function summarizeRevokeResults(
  results: Array<ChatSessionRevokeNotifyResult | "deadline">,
  targets: number
): ChatRevokeBulkSummary {
  const notified = results.filter((r) => r === "ok").length;
  const failed = results.filter((r) => r === "failed").length;
  const notConfigured = results.filter((r) => r === "skipped").length;
  const deadlineSkipped = results.filter((r) => r === "deadline").length;
  let status: ChatRevokeBulkStatus;
  if (targets === 0 && results.length === 0) status = "none";
  else if (notified === targets && targets > 0 && notified === results.length) status = "ok";
  else if (notified === 0 && notConfigured > 0 && failed === 0 && deadlineSkipped === 0) status = "not_configured";
  else if (notified === 0) status = "failed";
  else status = "partial";
  return { status, targets, notified, failed, notConfigured, deadlineSkipped };
}

/**
 * 여러 캐디(일괄 퇴사)의 연결 계정에 폐기 알림. 커밋 이후 호출.
 * - 알림 시점의 최신 sessionVersion 을 읽어 보낸다(Worker 는 max 로 기억 → 중복·순서 뒤바뀜에도 되돌림 없음).
 * - deadlineAt(에포크 ms)까지 끝낼 수 없는 계정은 시작하지 않고 "deadline" 으로 집계(조용히 성공 처리하지 않음).
 *   요청 시간 제한을 넘겨 이미 커밋된 결과까지 실패로 보이게 되는 것을 막기 위함.
 */
export async function notifyChatSessionRevokedForCaddyLinksDetailed(
  db: {
    user: {
      findMany: (args: {
        where: { caddyId: { in: number[] } };
        select: { id: true; sessionVersion: true };
      }) => Promise<Array<{ id: number; sessionVersion: number }>>;
    };
  },
  caddyIds: number[],
  opts?: { deadlineAt?: number; concurrency?: number; configured?: boolean }
): Promise<ChatRevokeBulkSummary> {
  const ids = Array.from(new Set(caddyIds.filter((id) => Number.isInteger(id) && id > 0)));
  if (ids.length === 0) return summarizeRevokeResults([], 0);
  let rows: Array<{ id: number; sessionVersion: number }>;
  try {
    rows = await db.user.findMany({
      where: { caddyId: { in: ids } },
      select: { id: true, sessionVersion: true },
    });
  } catch {
    console.error("[chat-session-revoke] notify lookup failed");
    // 대상 계정 수를 모르므로 추정하지 않고 unknown 으로 보고
    return unknownRevokeSummary();
  }
  if (rows.length === 0) return summarizeRevokeResults([], 0);
  const configured = opts?.configured ?? isChatSessionRevokeConfigured();
  if (!configured) {
    console.error(`[chat-session-revoke] notify not configured: ${rows.length} target(s) not notified`);
    return summarizeRevokeResults(rows.map(() => "skipped"), rows.length);
  }
  const conc = Math.max(1, opts?.concurrency ?? CHAT_SESSION_REVOKE_BULK_CONCURRENCY);
  const out: Array<ChatSessionRevokeNotifyResult | "deadline"> = [];
  for (let i = 0; i < rows.length; i += conc) {
    const chunk = rows.slice(i, i + conc);
    if (opts?.deadlineAt != null && Date.now() + CHAT_SESSION_REVOKE_TOTAL_BUDGET_MS > opts.deadlineAt) {
      for (let j = i; j < rows.length; j++) out.push("deadline");
      break;
    }
    out.push(
      ...(await Promise.all(
        chunk.map((row) =>
          notifyChatSessionRevoked({ userId: row.id, sessionVersion: row.sessionVersion })
        )
      ))
    );
  }
  const summary = summarizeRevokeResults(out, rows.length);
  if (summary.status !== "ok") {
    console.error(
      `[chat-session-revoke] bulk notify ${summary.status}: notified=${summary.notified} failed=${summary.failed} notConfigured=${summary.notConfigured} deadline=${summary.deadlineSkipped} of ${summary.targets}`
    );
  }
  return summary;
}

/** 설정 존재 여부만(값은 읽기만, 출력하지 않음). */
export function isChatSessionRevokeConfigured(env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return !!chatHttpBaseUrl() && !!chatInternalSecret(env);
  } catch {
    return false;
  }
}

/** 이전 호환(결과 배열). */
export async function notifyChatSessionRevokedForCaddyLinks(
  db: Parameters<typeof notifyChatSessionRevokedForCaddyLinksDetailed>[0],
  caddyIds: number[]
): Promise<ChatSessionRevokeNotifyResult[]> {
  const s = await notifyChatSessionRevokedForCaddyLinksDetailed(db, caddyIds);
  return [
    ...Array(s.notified).fill("ok"),
    ...Array(s.failed + s.deadlineSkipped).fill("failed"),
    ...Array(s.notConfigured).fill("skipped"),
  ];
}

/** 미완료 건수를 확정할 수 없는 요약(성공 아님). */
export function unknownRevokeSummary(): ChatRevokeBulkSummary {
  return { status: "unknown", targets: 0, notified: 0, failed: 0, notConfigured: 0, deadlineSkipped: 0 };
}

/**
 * 커밋 이후 전용: 절대 throw 하지 않는 일괄 알림. 예외 시 unknown 요약(건수·식별자 없이 로그).
 * 이미 커밋된 명단 반영이 알림 예외로 "반영 실패"로 보이지 않게 한다.
 */
export async function notifyChatSessionRevokedForCaddyLinksSafe(
  ...args: Parameters<typeof notifyChatSessionRevokedForCaddyLinksDetailed>
): Promise<ChatRevokeBulkSummary> {
  try {
    return await notifyChatSessionRevokedForCaddyLinksDetailed(...args);
  } catch {
    console.error("[chat-session-revoke] bulk notify error after commit: status=unknown");
    return unknownRevokeSummary();
  }
}

