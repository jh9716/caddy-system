import type { ChatSenderRole } from "../../cloudflare/verthill-chat/src/protocol";
import { isAllRoomId, isCustomRoomId, isDmRoomId } from "@/lib/chatRooms";

export const CHAT_BUBBLE_MAX_WIDTH = "76%";
export const CHAT_NEAR_BOTTOM_PX = 48;
export const CHAT_GROUP_WINDOW_MS = 5 * 60 * 1000;
export const SENSITIVE_PROFILE_KEYS = [
  "phone",
  "phoneNormalized",
  "kakaoUserId",
  "username",
  "password",
  "userId",
  "id",
  "token",
] as const;

export type ChatProfileView = {
  displayName: string;
  team: string;
  role: ChatSenderRole | string;
  userId: number;
};

export type ChatListRowKind = "ALL" | "CUSTOM" | "DM";

export function chatRoleLabel(role: string | null | undefined): string {
  if (role === "admin") return "관리자";
  if (role === "leader") return "조장";
  return "캐디";
}

export function chatAuthorLine(input: {
  displayName: string;
  team?: string | null;
  role?: string | null;
}): string {
  const name = String(input.displayName || "").trim() || "이름없음";
  if (input.role === "admin") return name;
  const team = String(input.team || "").trim();
  if (team && team !== "-") return `${team} ${name}`.trim();
  return name;
}

export function defaultAvatarInitial(name: string): string {
  const text = String(name || "").trim();
  return text ? text.slice(0, 1) : "?";
}

export function publicChatProfile(input: ChatProfileView): {
  displayName: string;
  team: string;
  role: string;
  roleLabel: string;
  authorLine: string;
} {
  const clean = {
    displayName: String(input.displayName || "").trim() || "이름없음",
    team: String(input.team || "").trim() || "-",
    role: String(input.role || "caddy"),
    roleLabel: chatRoleLabel(input.role),
    authorLine: chatAuthorLine(input),
  };
  for (const key of SENSITIVE_PROFILE_KEYS) {
    if (key in clean) throw new Error(`sensitive field leaked: ${key}`);
  }
  return clean;
}

export function canProfileMention(input: {
  roomId: string | null | undefined;
  isMember: boolean;
  targetUserId: number;
  myUserId: number;
}): boolean {
  const roomId = String(input.roomId || "");
  if (!roomId || isDmRoomId(roomId)) return false;
  if (!Number.isInteger(input.targetUserId) || input.targetUserId <= 0) return false;
  if (input.targetUserId === input.myUserId) return false;
  if (isAllRoomId(roomId)) return true;
  return isCustomRoomId(roomId) && input.isMember === true;
}

export function formatChatDateDivider(
  iso: string,
  now: Date = new Date()
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("ko-KR", {
    timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(d) || now.toDateString();
}

export function chatDateKey(iso: string | null | undefined): string {
  const d = new Date(String(iso || ""));
  if (Number.isNaN(d.getTime())) return "";
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function shouldShowDateDivider(
  prevIso: string | null | undefined,
  currIso: string | null | undefined
): boolean {
  const curr = chatDateKey(currIso);
  if (!curr) return false;
  const prev = chatDateKey(prevIso);
  return prev !== curr;
}

export function shouldShowAuthorMeta(input: {
  mine: boolean;
  deleted?: boolean;
  prevSenderUserId?: number | null;
  senderUserId: number;
  prevSentAt?: string | null;
  sentAt: string;
}): boolean {
  if (input.mine || input.deleted) return false;
  if (input.prevSenderUserId !== input.senderUserId) return true;
  const prev = new Date(String(input.prevSentAt || "")).getTime();
  const curr = new Date(input.sentAt).getTime();
  if (!Number.isFinite(prev) || !Number.isFinite(curr)) return true;
  return curr - prev > CHAT_GROUP_WINDOW_MS;
}

export function isNearChatBottom(input: {
  scrollHeight: number;
  scrollTop: number;
  clientHeight: number;
  thresholdPx?: number;
}): boolean {
  return (
    input.scrollHeight - input.scrollTop - input.clientHeight <
    (input.thresholdPx ?? CHAT_NEAR_BOTTOM_PX)
  );
}

export function shouldShowJumpButton(input: {
  stuckToBottom: boolean;
  unseenCount: number;
}): boolean {
  return !input.stuckToBottom && input.unseenCount > 0;
}

export function roomListTitle(room: {
  type: string;
  name: string;
  peerDisplayName?: string | null;
  peerTeam?: string | null;
  peerRole?: string | null;
}): string {
  if (room.type === "ALL") return "전체 채팅방";
  if (room.type === "DM") {
    return chatAuthorLine({
      displayName: String(room.peerDisplayName || room.name || "1:1 채팅"),
      team: room.peerTeam,
      role: room.peerRole,
    });
  }
  return String(room.name || "채팅방");
}

export function jumpToMessageIfMounted(input: {
  seq: number;
  root: ParentNode | null;
}): boolean {
  if (!input.root || !Number.isInteger(input.seq) || input.seq <= 0) return false;
  const el = input.root.querySelector(`[data-chat-seq="${input.seq}"]`);
  if (!(el instanceof HTMLElement)) return false;
  el.scrollIntoView({ block: "center", behavior: "smooth" });
  return true;
}
