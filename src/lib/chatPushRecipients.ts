import { isAllRoomId, isCustomRoomId, isDmRoomId } from "@/lib/chatRooms";
import {
  DEFAULT_CHAT_NOTIFY_MODE,
  resolveChatNotifyMode,
  type ChatNotifyMode,
} from "@/lib/chatNotificationPref";

export type ChatPushEvent = {
  roomId: string;
  seq: number;
  senderUserId: number;
  mentionAll: boolean;
  mentionUserIds: number[];
  replyToUserId: number | null;
  deletionType?: string | null;
};

export function isChatPushableEvent(event: ChatPushEvent): boolean {
  if (event.deletionType) return false;
  if (!Number.isInteger(event.seq) || event.seq <= 0) return false;
  if (!Number.isInteger(event.senderUserId) || event.senderUserId <= 0) return false;
  return Boolean(event.roomId);
}

export function candidateUserIdsForRoom(input: {
  roomId: string;
  memberUserIds: number[] | null | undefined;
  eligibleUserIds: number[];
}): number[] {
  const roomId = String(input.roomId ?? "").trim();
  if (isAllRoomId(roomId)) {
    return uniquePositiveIds(input.eligibleUserIds);
  }
  if (isCustomRoomId(roomId) || isDmRoomId(roomId)) {
    return uniquePositiveIds(input.memberUserIds ?? []);
  }
  return [];
}

export function shouldNotifyChatUser(input: {
  userId: number;
  senderUserId: number;
  mode?: ChatNotifyMode | string | null;
  mentionAll: boolean;
  mentionUserIds: readonly number[];
  replyToUserId?: number | null;
}): boolean {
  if (!Number.isInteger(input.userId) || input.userId <= 0) return false;
  if (input.userId === input.senderUserId) return false;
  const mode = resolveChatNotifyMode(input.mode ?? DEFAULT_CHAT_NOTIFY_MODE);
  if (mode === "OFF") return false;
  if (mode === "ALL") return true;
  if (input.mentionAll) return true;
  if (input.mentionUserIds.includes(input.userId)) return true;
  return input.replyToUserId === input.userId;
}

export function exclusiveChatWebPushRows<T extends { endpoint: string; userId: number }>(
  rows: readonly T[],
  otherEnabledEndpoints: readonly string[]
): T[] {
  const shared = new Set(otherEnabledEndpoints.filter(Boolean));
  if (shared.size === 0) return [...rows];
  return rows.filter((row) => !shared.has(row.endpoint));
}

export function selectChatPushRecipients(input: {
  event: ChatPushEvent;
  candidateUserIds: readonly number[];
  prefs: Readonly<Record<string, ChatNotifyMode | string>>;
}): number[] {
  if (!isChatPushableEvent(input.event)) return [];
  return uniquePositiveIds(input.candidateUserIds).filter((userId) =>
    shouldNotifyChatUser({
      userId,
      senderUserId: input.event.senderUserId,
      mode: input.prefs[String(userId)] ?? DEFAULT_CHAT_NOTIFY_MODE,
      mentionAll: input.event.mentionAll === true,
      mentionUserIds: input.event.mentionUserIds,
      replyToUserId: input.event.replyToUserId,
    })
  );
}

function uniquePositiveIds(ids: readonly number[] | null | undefined): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const raw of ids ?? []) {
    const id = Number(raw);
    if (!Number.isInteger(id) || id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}
