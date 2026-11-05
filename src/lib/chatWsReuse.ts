/**
 * Preview 전용: 같은 채팅방 재진입 시 방 WebSocket 재사용(파킹) 판단 — 순수 함수만.
 * - 운영 빌드에서는 항상 비활성. Preview 에서도 ?chatReuse=1 로 켠 탭(sessionStorage)에서만.
 * - 파킹 중 소켓은 클라이언트 세대(gen)가 달라 모든 이벤트를 무시한다(읽음 전송·화면 반영 없음).
 * - 재개 시 기존 첫 진입과 같은 최신 history 를 다시 받아 기존 경로(읽음·진입 위치)를 그대로 탄다.
 * 토큰·방 ID 등은 메모리 비교에만 쓰고 저장·기록하지 않는다.
 */
import { resolveChatAppEnv, type ChatAppEnvInput } from "./chatAppEnv";

export const CHAT_WS_REUSE_TTL_MS = 20000;
export const CHAT_WS_REUSE_STORAGE_KEY = "vh_chat_ws_reuse";
/** 최신 페이지 history 요청용 beforeSeq (서버 sendHistory(null) 과 같은 결과: seq < 이 값). */
export const CHAT_WS_REUSE_HISTORY_BEFORE = Number.MAX_SAFE_INTEGER;

/** Preview + (쿼리 chatReuse=1 또는 저장된 '1') 일 때만 true. chatReuse=0 이면 끔. 저장 값 변경도 반환. */
export function resolveChatWsReuse(
  env: ChatAppEnvInput,
  search: string | null | undefined,
  stored: string | null | undefined
): { enabled: boolean; store: "1" | null | undefined } {
  try {
    if (resolveChatAppEnv(env) !== "preview") return { enabled: false, store: undefined };
    const q = new URLSearchParams(String(search || "")).get("chatReuse");
    if (q === "1") return { enabled: true, store: "1" };
    if (q === "0") return { enabled: false, store: null };
    return { enabled: stored === "1", store: undefined };
  } catch {
    return { enabled: false, store: undefined };
  }
}

export type ParkedSocketMeta = { roomId: string; token: string; exp: number };

/**
 * 파킹 경과 판정(벽시계 기준). 모바일 백그라운드에서 setTimeout 이 늦게 돌아도 실제 경과로 판단한다.
 * 시작 시각이 없거나 시계가 거꾸로 가면(음수) 만료로 본다(fail-closed).
 */
export function isParkExpired(parkedAt: number | null | undefined, nowMs: number, ttlMs: number = CHAT_WS_REUSE_TTL_MS): boolean {
  if (typeof parkedAt !== "number" || !Number.isFinite(parkedAt) || !Number.isFinite(nowMs)) return true;
  const elapsed = nowMs - parkedAt;
  return elapsed < 0 || elapsed > ttlMs;
}

/**
 * 재개 직전 권한 재확인 결과 판정(fail-closed).
 * 기존 Worker GET /directory/rooms/{roomId}?token=(파킹 소켓과 같은 토큰) 은 새 연결과 같은 확인을 거친다:
 * 토큰 서명·만료 → Worker→앱 session-check(DB sessionVersion·퇴사/채팅 차단) → Directory 멤버십(전체방 제외).
 * HTTP 200 이고 응답 방이 요청 방과 같을 때만 통과. 그 외(401/403/404/5xx/네트워크/형식 오류)는 재사용 금지 → 새 연결.
 */
export function isResumeRevalidationOk(status: number | null | undefined, body: unknown, roomId: string): boolean {
  if (status !== 200 || !roomId || !body || typeof body !== "object") return false;
  const room = (body as { room?: unknown }).room;
  if (!room || typeof room !== "object") return false;
  return (room as { roomId?: unknown }).roomId === roomId;
}

/** 재사용 가능: 파킹 경과 ≤ TTL + 같은 방 + 같은 토큰 + 토큰 만료 30초 이상 남음 + 소켓 OPEN. 하나라도 아니면 새 연결. */
export function canResumeParked(
  parked: ParkedSocketMeta | null | undefined,
  req: { roomId: string; token: string; nowSec: number; socketOpen: boolean; parkedAt?: number | null; nowMs?: number }
): boolean {
  if (!parked || !req.socketOpen) return false;
  if (isParkExpired(req.parkedAt, typeof req.nowMs === "number" ? req.nowMs : NaN)) return false;
  if (!parked.roomId || parked.roomId !== req.roomId) return false;
  if (!parked.token || parked.token !== req.token) return false;
  if (!Number.isFinite(parked.exp) || parked.exp - 30 <= req.nowSec) return false;
  return true;
}

/** 재확인 요청 시간 제한(ms). 넘으면 중단 → 재사용 거부(fail-closed) → 새 연결. */
export const CHAT_WS_REUSE_REVALIDATE_TIMEOUT_MS = 2500;

/** Preview 진단용 재사용 실패 사유(고정 코드만. 방·사용자·토큰·URL 없음). */
export const CHAT_WS_REUSE_FAIL_REASONS = [
  "not_parked",
  "ttl",
  "socket",
  "token",
  "token_exp",
  "room_mismatch",
  "no_resume",
  "revalidate_401",
  "revalidate_403",
  "revalidate_404",
  "revalidate_4xx",
  "revalidate_5xx",
  "revalidate_body",
  "network_or_cors",
  "timeout",
  "superseded",
  "resume_failed",
] as const;
export type ChatWsReuseFailReason = (typeof CHAT_WS_REUSE_FAIL_REASONS)[number];

export function sanitizeReuseFailReason(v: unknown): ChatWsReuseFailReason | null {
  return typeof v === "string" && (CHAT_WS_REUSE_FAIL_REASONS as readonly string[]).includes(v)
    ? (v as ChatWsReuseFailReason)
    : null;
}

/** 재개 자격 실패 사유(canResumeParked 와 같은 조건, 첫 번째 실패만). 통과면 null. */
export function reuseEligibilityFailReason(
  parked: ParkedSocketMeta | null | undefined,
  req: { roomId: string; token: string; nowSec: number; socketOpen: boolean; parkedAt?: number | null; nowMs?: number }
): ChatWsReuseFailReason | null {
  if (!parked) return "not_parked";
  if (isParkExpired(req.parkedAt, typeof req.nowMs === "number" ? req.nowMs : NaN)) return "ttl";
  if (!req.socketOpen) return "socket";
  if (!parked.roomId || parked.roomId !== req.roomId) return "room_mismatch";
  if (!parked.token || parked.token !== req.token) return "token";
  if (!Number.isFinite(parked.exp) || parked.exp - 30 <= req.nowSec) return "token_exp";
  return null;
}

/** 재확인 HTTP 결과 → 실패 사유(통과면 null). isResumeRevalidationOk 와 같은 판정. */
export function revalidationFailReason(status: number | null | undefined, body: unknown, roomId: string): ChatWsReuseFailReason | null {
  if (isResumeRevalidationOk(status, body, roomId)) return null;
  if (status === 401) return "revalidate_401";
  if (status === 403) return "revalidate_403";
  if (status === 404) return "revalidate_404";
  if (typeof status === "number" && status >= 500) return "revalidate_5xx";
  if (typeof status === "number" && status >= 400) return "revalidate_4xx";
  if (status === 200) {
    const room = body && typeof body === "object" ? (body as { room?: { roomId?: unknown } }).room : null;
    if (room && typeof room === "object" && room.roomId !== roomId) return "room_mismatch";
    return "revalidate_body";
  }
  return "revalidate_body";
}

/** fetch 예외 → 사유. 브라우저는 CORS 차단과 네트워크 오류를 구분해 주지 않으므로 하나로 묶는다. */
export function revalidationErrorReason(err: unknown, timedOut: boolean): ChatWsReuseFailReason {
  if (timedOut) return "timeout";
  const name = err && typeof err === "object" ? String((err as { name?: unknown }).name || "") : "";
  if (name === "AbortError" || name === "TimeoutError") return "timeout";
  return "network_or_cors";
}

/**
 * 재개 직전 권한 재확인 실행(fail-closed). 기존 Worker 방 조회 URL 을 그대로 GET(쿠키·추가 헤더 없음).
 * 200 + 같은 방일 때만 ok. HTTP 오류·CORS/네트워크 예외·시간 초과·형식 오류는 모두 ok=false + 사유 코드.
 */
export async function revalidateParkedRoom(
  fetchFn: (url: string, init: { cache: "no-store"; signal?: AbortSignal }) => Promise<{ status: number; json: () => Promise<unknown> }>,
  url: string,
  roomId: string,
  timeoutMs: number = CHAT_WS_REUSE_REVALIDATE_TIMEOUT_MS
): Promise<{ ok: boolean; reason: ChatWsReuseFailReason | null }> {
  if (!url || !roomId) return { ok: false, reason: "network_or_cors" };
  let timedOut = false;
  const ctrl = typeof AbortController !== "undefined" ? new AbortController() : null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      try {
        ctrl?.abort();
      } catch {
        // ignore
      }
      reject(Object.assign(new Error("timeout"), { name: "TimeoutError" }));
    }, timeoutMs);
  });
  try {
    const res = await Promise.race([fetchFn(url, { cache: "no-store", signal: ctrl?.signal }), timeout]);
    const body = await Promise.race([res.json().catch(() => null), timeout]);
    if (timedOut) return { ok: false, reason: "timeout" };
    const reason = revalidationFailReason(res.status, body, roomId);
    return reason === null ? { ok: true, reason: null } : { ok: false, reason };
  } catch (err) {
    return { ok: false, reason: revalidationErrorReason(err, timedOut) };
  } finally {
    if (timer) clearTimeout(timer);
    timeout.catch(() => undefined);
  }
}
