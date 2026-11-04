/**
 * 채팅 빠른 진입 (P0).
 * - 같은 탭·같은 세션 메모리에서만 토큰/목록 재사용. localStorage·sessionStorage 에는 저장하지 않는다.
 * - 로그인/로그아웃/계정전환(subscribeChatSessionReset) 시 즉시 폐기. 전체 새로고침 시 자동 소멸.
 * - 재사용 토큰이 Worker 에서 거절되면 호출측이 invalidate 후 새로 발급한다 (권한 검사는 항상 Worker/서버).
 */
import { isChatSessionEnded, subscribeChatSessionReset } from "@/lib/chatSessionReset";
import { isAllRoomId, isDmRoomId } from "@/lib/chatRooms";

export const CHAT_TOKEN_REUSE_MARGIN_SEC = 120;
export const CHAT_OPEN_ROOM_EVENT = "vh-chat-open-room";
export const PUSH_OPEN_MESSAGE_TYPE = "vh-push-open";

type TokenLike = { token: string; exp: number; user: { userId: number } };
type Cache<T, R> = { token: T | null; rooms: R[] | null; roomsUserId: number | null };

const cache: Cache<TokenLike, unknown> = { token: null, rooms: null, roomsUserId: null };
let subscribed = false;

function ensureSubscribed(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  try {
    subscribeChatSessionReset(() => clearChatFastEntryCache());
  } catch {
    // no-op
  }
}

export function clearChatFastEntryCache(): void {
  cache.token = null;
  cache.rooms = null;
  cache.roomsUserId = null;
}

export function isReusableChatToken(
  info: { exp?: number; token?: string } | null | undefined,
  nowSec = Math.floor(Date.now() / 1000),
  marginSec = CHAT_TOKEN_REUSE_MARGIN_SEC
): boolean {
  if (!info || !info.token || typeof info.exp !== "number" || !Number.isFinite(info.exp)) return false;
  return info.exp - marginSec > nowSec;
}

export function readReusableChatToken<T extends TokenLike>(nowSec?: number): T | null {
  ensureSubscribed();
  if (isChatSessionEnded()) return null;
  const t = cache.token as T | null;
  if (!isReusableChatToken(t, nowSec)) {
    cache.token = null;
    return null;
  }
  return t;
}

export function rememberChatToken(info: TokenLike | null | undefined): void {
  ensureSubscribed();
  if (!info || !info.token || isChatSessionEnded()) return;
  if (cache.token && cache.token.user?.userId !== info.user?.userId) {
    cache.rooms = null;
    cache.roomsUserId = null;
  }
  cache.token = info;
}

export function invalidateChatToken(): void {
  cache.token = null;
}

export function rememberChatRooms<R>(userId: number | null | undefined, rooms: R[]): void {
  ensureSubscribed();
  if (!userId || isChatSessionEnded()) return;
  cache.rooms = rooms.slice();
  cache.roomsUserId = userId;
}

export function readCachedChatRooms<R>(userId: number | null | undefined): R[] | null {
  ensureSubscribed();
  if (!userId || isChatSessionEnded() || cache.roomsUserId !== userId || !cache.rooms) return null;
  return (cache.rooms as R[]).slice();
}

/** 딥링크 즉시 입장용 최소 요약. 권한은 Worker 가 WS 에서 판정한다. */
export function placeholderChatRoomSummary(roomId: string) {
  const type: "ALL" | "CUSTOM" | "DM" = isAllRoomId(roomId) ? "ALL" : isDmRoomId(roomId) ? "DM" : "CUSTOM";
  return {
    roomId,
    name: type === "ALL" ? "전체 채팅방" : "채팅방",
    type,
    ownerUserId: null,
    memberCount: 0,
    lastMessageSeq: 0,
    lastMessagePreview: "",
    lastMessageAt: null,
    lastSenderName: null,
    lastSenderRole: null,
    unread: 0,
    createdAt: "",
  };
}

/** 같은 origin 의 앱 내부 경로만 허용 ("/..." 이고 "//" 아님). */
export function safeInAppPath(raw: unknown, origin: string): string | null {
  try {
    const s = String(raw ?? "").trim();
    if (!s) return null;
    const u = new URL(s, origin);
    if (u.origin !== origin) return null;
    if (!u.pathname.startsWith("/") || u.pathname.startsWith("//")) return null;
    return u.pathname + u.search + u.hash;
  } catch {
    return null;
  }
}

/**
 * 알림 경로로 앱 안에서 이동. 이미 /chat 화면이면 새로고침 없이 방 열기 이벤트,
 * 아니면 SPA 라우팅(routerPush). 실패 시 false → 호출측이 기존 전체 이동으로 폴백.
 */
export function openPushPathInApp(
  rawPath: unknown,
  routerPush: (href: string) => void,
  win: Window | undefined = typeof window !== "undefined" ? window : undefined
): boolean {
  try {
    if (!win) return false;
    const path = safeInAppPath(rawPath, win.location.origin);
    if (!path) return false;
    const u = new URL(path, win.location.origin);
    const roomId = u.pathname === "/chat" ? u.searchParams.get("room") : null;
    if (roomId && win.location.pathname === "/chat") {
      win.history.pushState(win.history.state, "", path);
      win.dispatchEvent(new CustomEvent(CHAT_OPEN_ROOM_EVENT, { detail: { roomId } }));
      return true;
    }
    routerPush(path);
    return true;
  } catch {
    return false;
  }
}
