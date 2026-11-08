/**
 * 채팅 진입 속도 계측 (Preview·로컬 개발 전용).
 * - 단계 이름 + ms 만 기록. 사용자 ID·방 ID·메시지·토큰·URL 쿼리는 받지도 저장하지도 않는다.
 * - 모든 함수는 예외를 삼키고 동기 반환 → 채팅 동작을 막지 않는다.
 * - 시간 원천은 chatPhotoTiming.chatPhotoNow 재사용.
 */
import { currentChatAppEnv, type ChatAppEnv } from "@/lib/chatAppEnv";
import { chatPhotoNow } from "@/lib/chatPhotoTiming";

export const CHAT_ENTRY_TIMING_STEPS = [
  "entry_to_ui", // 1. ChatClient 마운트 → 초기 UI(목록) 표시
  "nav_to_ui", // 1-보조. 문서 navigation 시작 → 초기 UI (전체 로드 진입일 때만 의미)
  "token", // 2. 토큰 요청 → 응답
  "rooms_to_shown", // 3. 목록 요청 시작 → 첫 정상 목록 반영
  "room_select_to_ws_open", // 4
  "room_select_to_first_paint", // 4b. cache paint or first history page (not WS RTT)
  "ws_open_to_history", // 5. server history verified
  "push_nav_to_room", // 6. 알림/딥링크 진입: navigation 시작 → 대상 방 메시지 표시 (클릭 시각 자체는 측정 불가)
] as const;
export type ChatEntryTimingStep = (typeof CHAT_ENTRY_TIMING_STEPS)[number];
export type ChatEntryTimingMark = { name: ChatEntryTimingStep; ms: number };

const STEP_SET = new Set<string>(CHAT_ENTRY_TIMING_STEPS);
const MAX_MARKS = 200;

declare global {
  // eslint-disable-next-line no-var
  var __CHAT_ENTRY_TIMING__: ChatEntryTimingMark[] | undefined;
}

export function isChatEntryTimingEnabledFor(appEnv: ChatAppEnv, nodeEnv: string | undefined): boolean {
  return appEnv === "preview" || nodeEnv === "development";
}

let enabledCache: boolean | null = null;
export function isChatEntryTimingEnabled(): boolean {
  if (enabledCache != null) return enabledCache;
  try {
    enabledCache = isChatEntryTimingEnabledFor(currentChatAppEnv(), process.env.NODE_ENV);
  } catch {
    enabledCache = false;
  }
  return enabledCache;
}

export function resetChatEntryTimingForTests(enabled: boolean | null): void {
  enabledCache = enabled;
  globalThis.__CHAT_ENTRY_TIMING__ = undefined;
}

export function chatEntryNow(): number {
  try {
    return chatPhotoNow();
  } catch {
    return Date.now();
  }
}

/** startedAt 이 null 이면 기록하지 않는다. 반환: 기록한 ms 또는 null. */
export function recordChatEntryTiming(
  name: ChatEntryTimingStep,
  startedAt: number | null | undefined,
  now = chatEntryNow()
): number | null {
  try {
    if (!isChatEntryTimingEnabled()) return null;
    if (!STEP_SET.has(name)) return null;
    if (typeof startedAt !== "number" || !Number.isFinite(startedAt)) return null;
    const ms = Math.max(0, Math.round(now - startedAt));
    const bag = (globalThis.__CHAT_ENTRY_TIMING__ ||= []);
    if (bag.length >= MAX_MARKS) bag.shift();
    bag.push({ name, ms });
    if (typeof console !== "undefined" && typeof console.debug === "function") {
      console.debug(`[chat-entry] ${name} ${ms}ms`);
    }
    return ms;
  } catch {
    return null;
  }
}

export function readChatEntryTimings(): ChatEntryTimingMark[] {
  return [...(globalThis.__CHAT_ENTRY_TIMING__ || [])];
}

/** 늦게 온 알림설정 응답이 사용자가 바꾼(저장 중/저장 완료) 방 설정을 덮지 않게 병합. */
export function mergeLateNotifyPrefs<T>(
  current: Record<string, T>,
  incoming: Record<string, T>,
  dirtyKeys: ReadonlySet<string>
): Record<string, T> {
  const next: Record<string, T> = { ...incoming };
  for (const key of dirtyKeys) {
    if (Object.prototype.hasOwnProperty.call(current, key)) next[key] = current[key]!;
    else delete next[key];
  }
  for (const key of Object.keys(current)) {
    if (!(key in next)) next[key] = current[key]!;
  }
  return next;
}

/** 초기화 실패 분류: 인증(세션 종료 흐름에 맡김) vs 일반 오류(다시 시도 UI). */
export type ChatInitFailure = "auth" | "network";
export function classifyChatInitFailure(input: { status?: number | null; thrown?: boolean }): ChatInitFailure {
  if (input.status === 401 || input.status === 403) return "auth";
  return "network";
}

/** /api/chat/token Server-Timing 값 (ms 만, 식별자·값 없음). */
export function chatTokenServerTiming(authMs: number, issueMs: number): string {
  const r = (n: number) => (Number.isFinite(n) ? Math.max(0, Math.round(n)) : 0);
  return `auth;dur=${r(authMs)}, issue;dur=${r(issueMs)}`;
}
