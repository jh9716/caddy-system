/**
 * Phase 2 room ids:
 * - `all` overall room (pinned, cannot leave)
 * - `room_<16 hex>` user-created rooms (stable id, name is separate)
 * - `team-1`…`team-12` legacy Phase 1 rooms (kept in DO storage, hidden in new UI)
 *
 * Future FCM tag: `chat:<roomId>` — identity stays on roomId, not display name.
 */

export const ALL_ROOM_ID = "all";
export const ALL_ROOM_NAME = "전체 채팅방";
export const CUSTOM_ROOM_ID_RE = /^room_[0-9a-f]{16}$/;
export const LEGACY_TEAM_ROOM_RE = /^team-([1-9]|1[0-2])$/;
export const CHAT_ROOM_ID_RE = LEGACY_TEAM_ROOM_RE;
export const ROOM_NAME_MIN = 1;
export const ROOM_NAME_MAX = 24;
export const MAX_CUSTOM_MEMBERS = 80;
export const CHAT_PREVIEW_MAX = 80;

export type ChatRoomType = "ALL" | "CUSTOM";

export function teamToChatRoomId(team: string): string | null {
  const trimmed = String(team ?? "").trim();
  const n = trimmed.replace(/조$/, "");
  if (!/^[1-9]$|^1[0-2]$/.test(n) || !trimmed.endsWith("조")) return null;
  return `team-${n}`;
}

export function chatRoomIdToTeam(roomId: string): string | null {
  const match = LEGACY_TEAM_ROOM_RE.exec(String(roomId ?? "").trim());
  return match ? `${match[1]}조` : null;
}

export function isLegacyTeamRoomId(roomId: string): boolean {
  return LEGACY_TEAM_ROOM_RE.test(String(roomId ?? "").trim());
}

export function isAllRoomId(roomId: string): boolean {
  return String(roomId ?? "").trim() === ALL_ROOM_ID;
}

export function isCustomRoomId(roomId: string): boolean {
  return CUSTOM_ROOM_ID_RE.test(String(roomId ?? "").trim());
}

export function isPhase2RoomId(roomId: string): boolean {
  return isAllRoomId(roomId) || isCustomRoomId(roomId);
}

export function isConnectableRoomId(roomId: string): boolean {
  return isPhase2RoomId(roomId) || isLegacyTeamRoomId(roomId);
}

/** @deprecated Phase 1 alias — team rooms only. */
export function isChatRoomId(roomId: string): boolean {
  return isLegacyTeamRoomId(roomId);
}

export function generateCustomRoomId(
  randomBytes: () => Uint8Array = () => crypto.getRandomValues(new Uint8Array(8))
): string {
  const bytes = randomBytes();
  let hex = "";
  for (let i = 0; i < 8; i++) hex += (bytes[i] ?? 0).toString(16).padStart(2, "0");
  return `room_${hex}`;
}

export function sanitizeChatRoomName(name: string): string {
  return String(name ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, ROOM_NAME_MAX);
}

export function chatNotificationTag(roomId: string): string {
  return `chat:${String(roomId ?? "").trim()}`;
}

export function truncateChatPreview(body: string, max = CHAT_PREVIEW_MAX): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function computeChatUnread(latestSeq: number, lastReadSeq: number): number {
  const latest = Number(latestSeq);
  const read = Number(lastReadSeq);
  if (!Number.isFinite(latest) || !Number.isFinite(read)) return 0;
  return Math.max(0, Math.floor(latest) - Math.floor(read));
}

export type ChatRoomSortInput = {
  type: ChatRoomType | string;
  lastMessageAt?: string | null;
  createdAt?: string | null;
};

export function sortChatRoomSummaries<T extends ChatRoomSortInput>(rooms: T[]): T[] {
  return [...rooms].sort((a, b) => {
    if (a.type === "ALL" && b.type !== "ALL") return -1;
    if (b.type === "ALL" && a.type !== "ALL") return 1;
    const at = String(a.lastMessageAt || a.createdAt || "");
    const bt = String(b.lastMessageAt || b.createdAt || "");
    if (at !== bt) return bt.localeCompare(at);
    return 0;
  });
}
