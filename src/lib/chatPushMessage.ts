import { chatNotificationTag, isDmRoomId, truncateChatPreview } from "@/lib/chatRooms";
import { roomListTitle } from "@/lib/chatPhase5";

export function chatPushOpenPath(roomId: string): string {
  const id = String(roomId ?? "").trim();
  return id ? `/chat?room=${encodeURIComponent(id)}` : "/chat";
}

export function buildChatPushPayload(input: {
  roomId: string;
  roomType: string;
  roomName?: string | null;
  peerDisplayName?: string | null;
  peerTeam?: string | null;
  peerRole?: string | null;
  senderName: string;
  preview: string;
  mentionAll: boolean;
  mentioned: boolean;
}): {
  title: string;
  body: string;
  url: string;
  tag: string;
} {
  const roomTitle = roomListTitle({
    type: input.roomType,
    name: String(input.roomName || ""),
    peerDisplayName: input.peerDisplayName,
    peerTeam: input.peerTeam,
    peerRole: input.peerRole,
  });
  const highlight = input.mentionAll || input.mentioned;
  const title = highlight
    ? `멘션 · ${roomTitle}`
    : isDmRoomId(input.roomId)
      ? `1:1 · ${roomTitle}`
      : roomTitle;
  const sender = String(input.senderName || "이름없음").trim() || "이름없음";
  const preview = truncateChatPreview(input.preview || "", 80);
  return {
    title,
    body: preview ? `${sender}: ${preview}` : sender,
    url: chatPushOpenPath(input.roomId),
    tag: chatNotificationTag(input.roomId),
  };
}
