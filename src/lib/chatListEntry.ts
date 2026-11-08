/**
 * Chat list entry (P1).
 * Directory session-check / membership stay on the Worker.
 * Persist room rows only (never the chat token). Logout wipes storage.
 */

export const CHAT_ROOMS_STORAGE_KEY = "vh-chat-dir-rooms-v1";
export const CHAT_ROOMS_PERSIST_MAX = 64;
export const WS_CONNECTING = 0;
export const WS_OPEN = 1;

export type PersistedChatRoomRow = {
  roomId: string;
  name: string;
  type: "ALL" | "CUSTOM" | "DM";
  ownerUserId: number | null;
  memberCount: number;
  lastMessageSeq: number;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  lastSenderName: string | null;
  lastSenderRole: string | null;
  unread: number;
  createdAt: string;
  peerUserId?: number | null;
  peerDisplayName?: string | null;
  peerRole?: string | null;
  peerTeam?: string | null;
};

export type PersistedChatRooms = {
  v: 1;
  userId: number;
  rooms: PersistedChatRoomRow[];
};

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

function clipText(raw: unknown, max: number): string {
  const s = typeof raw === "string" ? raw : raw == null ? "" : String(raw);
  return s.length > max ? s.slice(0, max) : s;
}

function asIntOrNull(raw: unknown): number | null {
  if (raw == null) return null;
  const n = Number(raw);
  return Number.isInteger(n) ? n : null;
}

function parseRoomRow(raw: unknown): PersistedChatRoomRow | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as Record<string, unknown>;
  const roomId = clipText(rec.roomId, 200).trim();
  const type = rec.type;
  if (!roomId) return null;
  if (type !== "ALL" && type !== "CUSTOM" && type !== "DM") return null;
  const unread = Number(rec.unread);
  const memberCount = Number(rec.memberCount);
  const lastMessageSeq = Number(rec.lastMessageSeq);
  return {
    roomId,
    name: clipText(rec.name, 200),
    type,
    ownerUserId: asIntOrNull(rec.ownerUserId),
    memberCount: Number.isFinite(memberCount) ? memberCount : 0,
    lastMessageSeq: Number.isFinite(lastMessageSeq) ? lastMessageSeq : 0,
    lastMessagePreview: clipText(rec.lastMessagePreview, 200),
    lastMessageAt: typeof rec.lastMessageAt === "string" ? rec.lastMessageAt.slice(0, 40) : null,
    lastSenderName: rec.lastSenderName == null ? null : clipText(rec.lastSenderName, 80),
    lastSenderRole: rec.lastSenderRole == null ? null : clipText(rec.lastSenderRole, 40),
    unread: Number.isFinite(unread) ? unread : 0,
    createdAt: clipText(rec.createdAt, 40),
    peerUserId: asIntOrNull(rec.peerUserId),
    peerDisplayName: rec.peerDisplayName == null ? undefined : clipText(rec.peerDisplayName, 80),
    peerRole: rec.peerRole == null ? undefined : clipText(rec.peerRole, 40),
    peerTeam: rec.peerTeam == null ? undefined : clipText(rec.peerTeam, 80),
  };
}

export function parsePersistedChatRooms(raw: unknown): PersistedChatRooms | null {
  if (!raw || typeof raw !== "object") return null;
  const rec = raw as { v?: unknown; userId?: unknown; rooms?: unknown; token?: unknown };
  if (rec.token) return null;
  if (rec.v !== 1) return null;
  const userId = Number(rec.userId);
  if (!Number.isInteger(userId) || userId <= 0) return null;
  if (!Array.isArray(rec.rooms)) return null;
  const rooms: PersistedChatRoomRow[] = [];
  for (const item of rec.rooms.slice(0, CHAT_ROOMS_PERSIST_MAX)) {
    const row = parseRoomRow(item);
    if (row) rooms.push(row);
  }
  if (rooms.length === 0) return null;
  return { v: 1, userId, rooms };
}

export function readPersistedChatRooms(sessionEnded = false): PersistedChatRooms | null {
  if (sessionEnded) {
    clearPersistedChatRooms();
    return null;
  }
  const storage = persistStorage();
  if (!storage) return null;
  try {
    const raw = storage.getItem(CHAT_ROOMS_STORAGE_KEY);
    if (!raw) return null;
    return parsePersistedChatRooms(JSON.parse(raw) as unknown);
  } catch {
    return null;
  }
}

export function writePersistedChatRooms(userId: number, rooms: unknown[]): void {
  const storage = persistStorage();
  if (!storage || !Number.isInteger(userId) || userId <= 0) return;
  const parsed = parsePersistedChatRooms({ v: 1, userId, rooms });
  if (!parsed) {
    try {
      storage.removeItem(CHAT_ROOMS_STORAGE_KEY);
    } catch {
      // quota / private mode
    }
    return;
  }
  try {
    storage.setItem(CHAT_ROOMS_STORAGE_KEY, JSON.stringify(parsed));
  } catch {
    // quota / private mode
  }
}

export function clearPersistedChatRooms(): void {
  const storage = persistStorage();
  if (!storage) return;
  try {
    storage.removeItem(CHAT_ROOMS_STORAGE_KEY);
  } catch {
    // ignore
  }
}

export function shouldPaintPersistedRooms(input: {
  sessionEnded: boolean;
  roomCount: number;
}): boolean {
  return input.sessionEnded !== true && input.roomCount > 0;
}

export function shouldDropPersistedRoomsOnToken(input: {
  persistedUserId: number | null | undefined;
  tokenUserId: number;
}): boolean {
  if (!input.persistedUserId) return false;
  return input.persistedUserId !== input.tokenUserId;
}

/** CONNECTING or OPEN: do not tear down for visibility / app resume. */
export function shouldReuseChatSocket(readyState: number | null | undefined): boolean {
  return readyState === WS_CONNECTING || readyState === WS_OPEN;
}

/**
 * HTTP directory list is a fallback. If rows are already on screen (persist or WS),
 * awaiting HTTP only duplicates Worker session-check.
 */
export function shouldAwaitDirectoryHttp(input: { paintedRoomCount: number }): boolean {
  return input.paintedRoomCount <= 0;
}
