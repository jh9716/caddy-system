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
