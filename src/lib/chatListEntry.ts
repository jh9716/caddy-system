/**
 * Chat list entry (P1).
 * Directory session-check / membership stay on the Worker.
 * Room rows are not written to localStorage (no preview, peer, or private names).
 * Leftover v1 persist is discarded and never painted.
 */

export const CHAT_ROOMS_STORAGE_KEY = "vh-chat-dir-rooms-v1";
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

export type ChatRoomListSource = "directory" | "cache";

type StorageLike = {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
};

let storageOverride: StorageLike | null | undefined;

export function setChatRoomsPersistStorage(storage: StorageLike | null | undefined): void {
  storageOverride = storage;
}

function persistStorage(): StorageLike | null {
  if (storageOverride !== undefined) return storageOverride;
  try {
    if (typeof window === "undefined") return null;
    return window.localStorage;
  } catch {
    return null;
  }
}

/** Drop leftover v1 list persist (preview / names). Never restore it. */
export function discardLegacyChatListPersist(): void {
  const storage = persistStorage();
  if (!storage) return;
  try {
    storage.removeItem(CHAT_ROOMS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function hasLegacyChatListPersist(): boolean {
  const storage = persistStorage();
  if (!storage) return false;
  try {
    return Boolean(storage.getItem(CHAT_ROOMS_STORAGE_KEY));
  } catch {
    return false;
  }
}

/** Cache is never a membership verdict. Only Directory WS/HTTP after auth. */
export function shouldApplyChatRoomList(input: {
  source: ChatRoomListSource;
  sessionEnded: boolean;
  authenticated: boolean;
}): boolean {
  if (input.sessionEnded === true || input.authenticated !== true) return false;
  return input.source === "directory";
}

export function shouldPaintPersistedRooms(_input?: {
  sessionEnded: boolean;
  roomCount: number;
}): boolean {
  return false;
}

/** CONNECTING or OPEN: do not tear down for visibility / app resume. */
export function shouldReuseChatSocket(readyState: number | null | undefined): boolean {
  return readyState === WS_CONNECTING || readyState === WS_OPEN;
}

/**
 * HTTP is the Directory fallback when WS is slow or fails.
 * Do not skip it because a cache (or leftover persist) already painted.
 */
export function shouldStartDirectoryHttpFallback(input: {
  sessionEnded: boolean;
  hasToken: boolean;
  hasCachedRooms?: boolean;
  directoryWsFailed?: boolean;
  directoryWsSlow?: boolean;
}): boolean {
  if (input.sessionEnded === true || input.hasToken !== true) return false;
  return true;
}
