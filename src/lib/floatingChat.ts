/**
 * PC 플로팅 채팅 P1 — 순수 함수 (표시 규칙, 상태 저장, 안 읽음 합계).
 * 채팅 서버 프로토콜·인증·권한은 바꾸지 않는다. 기존 /chat 과 같은 토큰·WS 경로를 쓴다.
 */
export const FLOATING_CHAT_STORAGE_KEY = "vh.floatingChat.v1";
/** 하단 탭/드로어가 사라지는 PC 기준(globals.css @media (min-width: 960px))과 같다. */
export const FLOATING_CHAT_MIN_WIDTH = 960;
export const FLOATING_CHAT_BODY_MAX = 2000;

export type FloatingChatUi = "closed" | "open" | "min";
export type FloatingChatState = { ui: FloatingChatUi; roomId: string | null };

const CHAT_ROLES = new Set(["admin", "caddy", "leader"]);

/** /chat 레이아웃과 같은 역할(admin·caddy·leader)만. 최종 판단은 기존 /api/chat/token 이 한다. */
export function canShowFloatingChat(input: {
  role: string | null | undefined;
  pathname: string | null | undefined;
  viewportWidth: number;
}): boolean {
  if (!input.role || !CHAT_ROLES.has(input.role)) return false;
  if (input.viewportWidth < FLOATING_CHAT_MIN_WIDTH) return false;
  const p = input.pathname || "/";
  if (p === "/chat" || p.startsWith("/chat/")) return false;
  if (p.startsWith("/login") || p.startsWith("/change-password")) return false;
  return true;
}

export function parseFloatingChatState(raw: string | null | undefined): FloatingChatState {
  const fallback: FloatingChatState = { ui: "closed", roomId: null };
  if (!raw) return fallback;
  try {
    const v = JSON.parse(raw) as Partial<FloatingChatState>;
    const ui: FloatingChatUi = v.ui === "open" || v.ui === "min" ? v.ui : "closed";
    const roomId = typeof v.roomId === "string" && v.roomId.length > 0 && v.roomId.length <= 128 ? v.roomId : null;
    return { ui, roomId };
  } catch {
    return fallback;
  }
}

export function serializeFloatingChatState(s: FloatingChatState): string {
  return JSON.stringify({ ui: s.ui, roomId: s.roomId });
}

/** 연결 정책: 닫힘 = 연결 없음. 열림/최소화 = 목록(directory) 1개. 대화방 소켓은 '열림 + 방 보기'일 때만. */
export function floatingChatSockets(input: { ui: FloatingChatUi; viewingRoom: boolean }): {
  directory: boolean;
  room: boolean;
} {
  if (input.ui === "closed") return { directory: false, room: false };
  return { directory: true, room: input.ui === "open" && input.viewingRoom };
}

export function totalUnread(rooms: ReadonlyArray<{ unread?: number | null }>): number {
  let n = 0;
  for (const r of rooms) {
    const u = Number(r.unread);
    if (Number.isFinite(u) && u > 0) n += Math.floor(u);
  }
  return n;
}

export function unreadBadgeText(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return "";
  return n > 99 ? "99+" : String(Math.floor(n));
}

export function normalizeOutgoingBody(raw: string): string | null {
  const body = String(raw ?? "").replace(/\r\n/g, "\n").trim();
  if (!body) return null;
  if (body.length > FLOATING_CHAT_BODY_MAX) return null;
  return body;
}

/**
 * 재연결 sync 페이지 이어받기 (ChatClient 와 같은 규칙: hasMore=true 면 newestSeq 이후로 다시 sync).
 * 커서가 앞으로 가지 않으면(서버 이상) 무한 반복을 막기 위해 null.
 */
export function nextFloatingSyncAfter(input: {
  hasMore: unknown;
  newestSeq: unknown;
  pageLastSeq: number | null | undefined;
  requestedAfter: number;
}): number | null {
  if (input.hasMore !== true) return null;
  const newest = Number(input.newestSeq);
  const fallback = Number(input.pageLastSeq) || 0;
  const next = Number.isInteger(newest) && newest > 0 ? newest : fallback;
  if (!Number.isInteger(next) || next <= input.requestedAfter) return null;
  return next;
}

/** 읽음은 이미 보낸 seq 보다 클 때만 (중복 read 방지). */
export function shouldSendFloatingRead(seq: number | null | undefined, lastSent: number): boolean {
  const n = Number(seq);
  return Number.isInteger(n) && n > 0 && n > lastSent;
}
