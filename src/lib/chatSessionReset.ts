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

export function parseChatSessionResetReason(raw: unknown): ChatSessionResetReason {
  const value = String(raw || "");
  return value === "account_switch" || value.startsWith("account_switch:")
    ? "account_switch"
    : "logout";
}

/** Same-tab CustomEvent and cross-tab StorageEvent must share this. */
export function applyChatSessionResetReason(reason: ChatSessionResetReason): void {
  if (reason === "logout") markChatSessionEnded();
  else clearChatSessionEnded();
}

export function shouldCommitChatToken(input?: {
  generationMatches?: boolean;
  sessionEnded?: boolean;
}): boolean {
  if (input?.sessionEnded === true || isChatSessionEnded()) return false;
  if (input?.generationMatches === false) return false;
  return true;
}

export function shouldConnectWithChatToken<T extends { token?: string }>(
  info: T | null | undefined,
  tokenRef: { current: T | null }
): boolean {
  if (isChatSessionEnded()) return false;
  const current = String(tokenRef.current?.token || "");
  const incoming = String(info?.token || "");
  return Boolean(current && incoming && current === incoming);
}

export function requestChatSessionReset(reason: ChatSessionResetReason): void {
  applyChatSessionResetReason(reason);
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

export function handleChatSessionResetSignal(
  raw: unknown,
  handler?: (reason: ChatSessionResetReason) => void
): ChatSessionResetReason {
  const reason = parseChatSessionResetReason(raw);
  applyChatSessionResetReason(reason);
  handler?.(reason);
  return reason;
}

export function subscribeChatSessionReset(
  handler: (reason: ChatSessionResetReason) => void
): () => void {
  if (typeof window === "undefined") return () => undefined;
  const deliver = (raw: unknown) => {
    handleChatSessionResetSignal(raw, handler);
  };
  const onEvent = (event: Event) => {
    deliver(
      event instanceof CustomEvent ? event.detail?.reason : "logout"
    );
  };
  const onStorage = (event: StorageEvent) => {
    if (event.key !== CHAT_SESSION_RESET_STORAGE_KEY) return;
    deliver(event.newValue);
  };
  window.addEventListener(CHAT_SESSION_RESET_EVENT, onEvent);
  window.addEventListener("storage", onStorage);
  return () => {
    window.removeEventListener(CHAT_SESSION_RESET_EVENT, onEvent);
    window.removeEventListener("storage", onStorage);
  };
}
