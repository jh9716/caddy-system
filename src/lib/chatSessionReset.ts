/**
 * Client chat-session teardown. Logout / account switch must close sockets
 * before a stale token can reconnect. No ChatClient global store.
 */

export const CHAT_SESSION_RESET_EVENT = "vh-chat-session-reset";
export const CHAT_SESSION_RESET_STORAGE_KEY = "vh-chat-session-reset";

export type ChatSessionResetReason = "logout" | "account_switch";

export type ChatSocketResetHandles<T> = {
  roomGenRef: { current: number };
  dirGenRef: { current: number };
  roomTimerRef: { current: number | null };
  dirTimerRef: { current: number | null };
  wsRef: { current: WebSocket | null };
  dirRef: { current: WebSocket | null };
  tokenRef: { current: T | null };
  reconnectingRef?: { current: boolean };
};

let sessionEnded = false;

export function isChatSessionEnded(): boolean {
  return sessionEnded;
}

export function markChatSessionEnded(): void {
  sessionEnded = true;
}

export function clearChatSessionEnded(): void {
  sessionEnded = false;
}

export function resetChatSocketHandles<T>(
  handles: ChatSocketResetHandles<T>
): void {
  handles.roomGenRef.current += 1;
  handles.dirGenRef.current += 1;
  if (handles.roomTimerRef.current != null) {
    clearTimeout(handles.roomTimerRef.current);
    handles.roomTimerRef.current = null;
  }
  if (handles.dirTimerRef.current != null) {
    clearTimeout(handles.dirTimerRef.current);
    handles.dirTimerRef.current = null;
  }
  if (handles.reconnectingRef) handles.reconnectingRef.current = false;
  handles.tokenRef.current = null;
  try {
    handles.wsRef.current?.close();
  } catch {
    // already closed
  }
  try {
    handles.dirRef.current?.close();
  } catch {
    // already closed
  }
  handles.wsRef.current = null;
  handles.dirRef.current = null;
}

export function shouldAttemptChatReconnect(input: {
  generationMatches: boolean;
  hasToken: boolean;
  sessionEnded?: boolean;
}): boolean {
  if (input.sessionEnded === true || isChatSessionEnded()) return false;
  return input.generationMatches === true && input.hasToken === true;
}

export function requestChatSessionReset(reason: ChatSessionResetReason): void {
  if (reason === "logout") markChatSessionEnded();
  else clearChatSessionEnded();
  if (typeof window === "undefined") return;
  window.dispatchEvent(
    new CustomEvent(CHAT_SESSION_RESET_EVENT, { detail: { reason } })
  );
  try {
    window.localStorage.setItem(
      CHAT_SESSION_RESET_STORAGE_KEY,
      `${reason}:${Date.now()}`
    );
  } catch {
    // private mode
  }
}

export function subscribeChatSessionReset(
  handler: (reason: ChatSessionResetReason) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const onEvent = (event: Event) => {
    const reason =
      event instanceof CustomEvent && event.detail?.reason === "account_switch"
        ? "account_switch"
        : "logout";
    handler(reason);
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CHAT_SESSION_RESET_STORAGE_KEY) return;
    const value = String(event.newValue || "");
    handler(value.startsWith("account_switch") ? "account_switch" : "logout");
  };
  window.addEventListener(CHAT_SESSION_RESET_EVENT, onEvent);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHAT_SESSION_RESET_EVENT, onEvent);
    window.removeEventListener("storage", onStorage);
  };
}
