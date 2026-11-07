/**
 * 앱 복귀(visibilitychange·Capacitor appStateChange·online) 재연결 중복 억제 — 순수 판정만.
 *
 * 문제(코드 확인): 모바일 앱 복귀 때 visibilitychange 와 Capacitor appStateChange 가 거의 동시에 둘 다 발생하고,
 * 네트워크 복귀 시 online 도 겹친다. 기존 reconnect() 는 호출마다 Directory·방 WebSocket 을 무조건 닫고 새로 연다.
 * 두 번째 호출은 첫 번째가 막 시작한(CONNECTING) 소켓을 끊고 다시 시작하므로
 *   - Worker 인증(토큰 검증 + session-check + 멤버십) 요청이 복귀 1회당 2배가 되고
 *   - 첫 번째 핸드셰이크 진행분이 버려져 "연결됨" 표시가 두 번째 핸드셰이크 완료까지 늦어진다.
 *
 * 규칙(fail-open = 기존 동작): 아래가 "모두" 참일 때만 이번 재연결을 건너뛴다. 하나라도 아니면 기존처럼 재연결.
 *   1) 직전 복귀 재연결이 windowMs 이내(벽시계, 음수 경과는 무효)
 *   2) 같은 토큰(재발급·계정 전환·세션 리셋 후에는 항상 재연결)
 *   3) 같은 방(또는 둘 다 목록 화면)
 *   4) 지금 붙어 있는 소켓이 직전 복귀 재연결이 만든 "바로 그" 소켓(참조 동일)
 *   5) 그 소켓들이 CONNECTING(0) 또는 OPEN(1) — 닫혔거나 닫히는 중이면 재연결
 * 서버 인증은 줄이지 않는다: 건너뛰는 경우에도 살아 있는 소켓은 windowMs 이내에 새로 인증받은 소켓이다.
 * 토큰·방 ID 는 메모리 비교에만 쓰고 저장·기록하지 않는다. 모듈 전역 상태 없음(호출자 ref 에만 보관).
 */

export const CHAT_RESUME_COALESCE_MS = 2000;
const WS_CONNECTING = 0;
const WS_OPEN = 1;

export type ChatResumeStamp<S = unknown> = {
  at: number;
  token: string;
  roomId: string | null;
  dirWs: S | null;
  roomWs: S | null;
};

export type ChatResumeCurrent<S = unknown> = {
  nowMs: number;
  token: string | null | undefined;
  roomId: string | null;
  dirWs: S | null;
  dirState: number | null | undefined;
  roomWs: S | null;
  roomState: number | null | undefined;
};

function live(state: number | null | undefined): boolean {
  return state === WS_CONNECTING || state === WS_OPEN;
}

export function shouldSkipResumeReconnect<S>(
  stamp: ChatResumeStamp<S> | null | undefined,
  cur: ChatResumeCurrent<S>,
  windowMs: number = CHAT_RESUME_COALESCE_MS
): boolean {
  try {
    if (!stamp || !cur || !cur.token) return false;
    if (!Number.isFinite(stamp.at) || !Number.isFinite(cur.nowMs)) return false;
    const elapsed = cur.nowMs - stamp.at;
    if (elapsed < 0 || elapsed > windowMs) return false;
    if (stamp.token !== cur.token) return false;
    if ((stamp.roomId ?? null) !== (cur.roomId ?? null)) return false;
    if (!stamp.dirWs || stamp.dirWs !== cur.dirWs || !live(cur.dirState)) return false;
    if (cur.roomId != null) {
      if (!stamp.roomWs || stamp.roomWs !== cur.roomWs || !live(cur.roomState)) return false;
    }
    return true;
  } catch {
    return false;
  }
}
