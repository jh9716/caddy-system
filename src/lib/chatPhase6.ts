import { isVisibleChatListRoom } from "@/lib/chatPhase5";
import {
  isPhase2RoomId,
  sortChatRoomSummaries,
  type ChatRoomSortInput,
} from "@/lib/chatRooms";

export type ChatListRoom = ChatRoomSortInput & {
  roomId: string;
  type: string;
};

export function upsertVisibleChatRoom<T extends ChatListRoom>(rooms: T[], room: T): T[] {
  if (!isVisibleChatListRoom(room.type) || !room.roomId) return rooms;
  return sortChatRoomSummaries([
    ...rooms.filter((row) => row.roomId !== room.roomId),
    room,
  ]);
}

export function rollbackOptimisticChatRoom<T extends { roomId: string }>(
  rooms: T[],
  roomId: string
): T[] {
  return rooms.filter((row) => row.roomId !== roomId);
}

export function parseChatDeepLinkRoomId(raw: unknown): string | null {
  const roomId = String(raw ?? "").trim();
  return isPhase2RoomId(roomId) ? roomId : null;
}

export const CHAT_PENDING_ROOM_KEY = "vh-chat-pending-room";

export function readPendingChatRoomId(storage: {
  getItem(key: string): string | null;
} | null): string | null {
  if (!storage) return null;
  try {
    return parseChatDeepLinkRoomId(storage.getItem(CHAT_PENDING_ROOM_KEY));
  } catch {
    return null;
  }
}

export function writePendingChatRoomId(
  storage: { setItem(key: string, value: string): void } | null,
  roomId: string | null
): void {
  if (!storage) return;
  try {
    if (!roomId) return;
    const parsed = parseChatDeepLinkRoomId(roomId);
    if (parsed) storage.setItem(CHAT_PENDING_ROOM_KEY, parsed);
  } catch {
    // ignore quota / private mode
  }
}

export function clearPendingChatRoomId(storage: {
  removeItem(key: string): void;
} | null): void {
  if (!storage) return;
  try {
    storage.removeItem(CHAT_PENDING_ROOM_KEY);
  } catch {
    // ignore
  }
}

export function resolveChatDeepLinkAction(input: {
  requestedRoomId: string | null;
  rooms: readonly { roomId: string }[];
  directorySnapshotReady: boolean;
}): "open" | "wait" | "fallback" | "none" {
  const roomId = parseChatDeepLinkRoomId(input.requestedRoomId);
  if (!roomId) return "none";
  if (input.rooms.some((row) => row.roomId === roomId)) return "open";
  return input.directorySnapshotReady ? "fallback" : "wait";
}

/**
 * Directory rooms snapshot readiness.
 * Socket `open` is never enough. Only an authoritative rooms array (WS or HTTP) is ready.
 * Starting a new WS generation must invalidate, or reconnect can reuse a stale true.
 */
export type DirectorySnapshotReadyEvent =
  | "connect_start"
  | "connect_skip"
  | "socket_open"
  | "authoritative_rooms"
  | "socket_error"
  | "socket_close";

export function nextDirectorySnapshotReady(
  current: boolean,
  event: DirectorySnapshotReadyEvent
): boolean {
  if (event === "connect_start" || event === "socket_error" || event === "socket_close") {
    return false;
  }
  if (event === "authoritative_rooms") return true;
  return current;
}
