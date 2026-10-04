import { isAllRoomId, isCustomRoomId, isDmRoomId } from "@/lib/chatRooms";

export const CHAT_NOTIFY_MODES = ["ALL", "MENTIONS", "OFF"] as const;
export type ChatNotifyMode = (typeof CHAT_NOTIFY_MODES)[number];
export const DEFAULT_CHAT_NOTIFY_MODE: ChatNotifyMode = "ALL";

export function parseChatNotifyMode(raw: unknown): ChatNotifyMode | null {
  const mode = String(raw ?? "").trim().toUpperCase();
  return CHAT_NOTIFY_MODES.includes(mode as ChatNotifyMode)
    ? (mode as ChatNotifyMode)
    : null;
}

export function resolveChatNotifyMode(raw: unknown): ChatNotifyMode {
  return parseChatNotifyMode(raw) ?? DEFAULT_CHAT_NOTIFY_MODE;
}

export function canWriteChatNotifyPref(input: {
  roomId: string;
  isMember: boolean;
}): boolean {
  const roomId = String(input.roomId ?? "").trim();
  if (isAllRoomId(roomId)) return true;
  if (isCustomRoomId(roomId) || isDmRoomId(roomId)) return input.isMember === true;
  return false;
}

export function isChatNotifyRoomId(roomId: string): boolean {
  return isAllRoomId(roomId) || isCustomRoomId(roomId) || isDmRoomId(roomId);
}

export function chatNotifyPrefMap(
  rows: readonly { roomId: string; mode: string }[]
): Record<string, ChatNotifyMode> {
  const out: Record<string, ChatNotifyMode> = {};
  for (const row of rows) {
    const roomId = String(row.roomId ?? "").trim();
    if (!isChatNotifyRoomId(roomId)) continue;
    out[roomId] = resolveChatNotifyMode(row.mode);
  }
  return out;
}
