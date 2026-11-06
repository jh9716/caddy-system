/**
 * 열린 WebSocket 의 주기적 세션 재검증(pure; Cloudflare import 없음 → Node 단위테스트 가능).
 *
 * 목적: 폐기 알림이 Room/Directory 에 도달하지 못해도, 이미 열린 소켓이 토큰 만료(최대 30분)까지
 * 남는 시간을 "재검증 주기 + 다음 활동 1회"로 줄인다.
 * - 핫패스(메시지 송수신)에서는 숫자 비교만. 재검증은 사용자·DO 별로 주기당 최대 1회, 비동기.
 * - Next 가 명확히 "폐기됨"(401 + stale_session/user_unavailable)이라고 답할 때만 소켓을 닫는다.
 *   Next 장애·시간 초과·설정 누락은 "unknown" → 닫지 않는다(정상 사용자 연결 안정성 우선).
 * - 아무 상태도 저장하지 않는다(소켓 종료만). 재접속은 기존 접속 검증(session-check)이 판단.
 */

export const OPEN_SOCKET_RECHECK_MS = 5 * 60 * 1000;
/** unknown(Next 장애 등) 후 다음 재시도까지 최소 간격. */
export const OPEN_SOCKET_RECHECK_RETRY_MS = 60 * 1000;
const MIN_RECHECK_MS = 1000;
const MAX_RECHECK_MS = 30 * 60 * 1000;

export type SessionProbeResult = "current" | "revoked" | "unknown";

/**
 * 재검증 주기. 기본 5분. `CHAT_OPEN_SOCKET_RECHECK_MS` 는 로컬 테스트 전용(운영 env 설정 불필요).
 * 숫자가 아니거나 범위를 벗어나면 기본값/경계값.
 */
export function openSocketRecheckIntervalMs(raw: unknown): number {
  if (raw == null || String(raw).trim() === "") return OPEN_SOCKET_RECHECK_MS;
  const n = Number(raw);
  if (!Number.isFinite(n)) return OPEN_SOCKET_RECHECK_MS;
  return Math.min(MAX_RECHECK_MS, Math.max(MIN_RECHECK_MS, Math.floor(n)));
}

/** 마지막 확인 시각(sc, ms)이 없거나 주기가 지났으면 true. */
export function isRecheckDue(checkedAt: unknown, nowMs: number, intervalMs: number): boolean {
  const sc = Number(checkedAt);
  if (!Number.isFinite(sc) || sc <= 0) return true;
  return nowMs - sc >= intervalMs;
}

/** unknown 이후 다음 확인이 retry 후에 오도록 sc 를 조정. */
export function retryCheckedAt(nowMs: number, intervalMs: number): number {
  return nowMs - intervalMs + Math.min(intervalMs, OPEN_SOCKET_RECHECK_RETRY_MS);
}

/** Next session-check 응답 분류. 명확한 폐기(401 + 알려진 코드)만 revoked. */
export function classifySessionProbe(status: number, body: unknown): SessionProbeResult {
  const rec = body && typeof body === "object" ? (body as { ok?: unknown; code?: unknown }) : null;
  if (status === 200 && rec?.ok === true) return "current";
  if (status === 401 && (rec?.code === "stale_session" || rec?.code === "user_unavailable")) {
    return "revoked";
  }
  return "unknown";
}
