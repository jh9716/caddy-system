export const BODY_MAX = 2000;
export const SENDER_MAX = 64;
export const CLIENT_ID_MAX = 128;
export const HISTORY_LIMIT = 30;
/**
 * Per-room hibernatable WebSocket cap.
 * Cloudflare hibernation supports up to 32,768 sockets per DO.
 * Custom/legacy rooms keep the Phase 1 200 cap.
 * Overall room (`all`) uses 400 to cover ~250 users + reconnect overlap.
 */
export const MAX_CONNECTIONS = 200;
export const MAX_CONNECTIONS_ALL = 400;
export const MAX_DIRECTORY_CONNECTIONS = 400;
export const MESSAGE_MAX = 4096;
export const ALL_ROOM_ID = "all";
export const ALL_ROOM_NAME = "전체 채팅방";
export const CUSTOM_ROOM_ID_RE = /^room_[0-9a-f]{16}$/;
export const LEGACY_TEAM_ROOM_RE = /^team-([1-9]|1[0-2])$/;
export const ROOM_NAME_RE = LEGACY_TEAM_ROOM_RE;
export const ALLOWED_ROOMS = [
  "team-1",
  "team-2",
  "team-3",
  "team-4",
  "team-5",
  "team-6",
  "team-7",
  "team-8",
  "team-9",
  "team-10",
  "team-11",
  "team-12",
] as const;
export const PREVIEW_MAX = 80;
export const DIRECTORY_NAME = "verthill-global";

export type ChatSenderRole = "admin" | "caddy" | "leader";

export type ChatMessage = {
  type: "message";
  clientMessageId: string;
  senderUserId: number;
  sender: string;
  senderRole: ChatSenderRole;
  body: string;
  sentAt: string;
  seq?: number;
};

export type HistoryEvent = {
  type: "history";
  messages: ChatMessage[];
  hasMore: boolean;
  oldestSeq: number | null;
};

export type ErrorEvent = {
  type: "error";
  code: string;
  message: string;
};

export type DuplicateEvent = {
  type: "duplicate";
  clientMessageId: string;
};

export type RoomSummary = {
  roomId: string;
  name: string;
  type: "ALL" | "CUSTOM";
  ownerUserId: number | null;
  memberCount: number;
  lastMessageSeq: number;
  lastMessagePreview: string;
  lastMessageAt: string | null;
  lastSenderName: string | null;
  lastSenderRole: ChatSenderRole | null;
  unread: number;
  createdAt: string;
  notificationTag: string;
};

export function isAllRoomId(room: string): boolean {
  return room === ALL_ROOM_ID;
}

export function isCustomRoomId(room: string): boolean {
  return CUSTOM_ROOM_ID_RE.test(room);
}

export function isLegacyTeamRoomId(room: string): boolean {
  return LEGACY_TEAM_ROOM_RE.test(room) && (ALLOWED_ROOMS as readonly string[]).includes(room);
}

export function isValidRoomName(room: string): boolean {
  return isAllRoomId(room) || isCustomRoomId(room) || isLegacyTeamRoomId(room);
}

export function chatNotificationTag(roomId: string): string {
  return `chat:${roomId}`;
}

export function truncatePreview(body: string, max = PREVIEW_MAX): string {
  const text = String(body ?? "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 1))}…`;
}

export function computeUnread(latestSeq: number, lastReadSeq: number): number {
  if (!Number.isFinite(latestSeq) || !Number.isFinite(lastReadSeq)) return 0;
  return Math.max(0, Math.floor(latestSeq) - Math.floor(lastReadSeq));
}

export function senderRoleFromClaims(role: string): ChatSenderRole {
  if (role === "admin") return "admin";
  if (role === "leader") return "leader";
  return "caddy";
}

export function validateIncomingMessage(raw: unknown):
  | { ok: true; value: { clientMessageId: string; body: string } }
  | { ok: false; code: string; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_payload", message: "JSON object required" };
  }
  const input = raw as Record<string, unknown>;
  if (input.type !== "message") {
    return { ok: false, code: "invalid_type", message: "type must be message" };
  }
  const clientMessageId = String(input.clientMessageId ?? "").trim();
  const body = typeof input.body === "string" ? input.body : "";
  if (!clientMessageId || clientMessageId.length > CLIENT_ID_MAX) {
    return {
      ok: false,
      code: "invalid_client_message_id",
      message: "clientMessageId required",
    };
  }
  if (body.length === 0) {
    return { ok: false, code: "invalid_body", message: "body required" };
  }
  if (body.length > BODY_MAX) {
    return {
      ok: false,
      code: "body_too_long",
      message: `body max ${BODY_MAX}`,
    };
  }
  return { ok: true, value: { clientMessageId, body } };
}

export function validateIncomingRead(raw: unknown):
  | { ok: true; seq: number }
  | { ok: false; code: string; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_payload", message: "JSON object required" };
  }
  const input = raw as Record<string, unknown>;
  if (input.type !== "read") {
    return { ok: false, code: "invalid_type", message: "type must be read" };
  }
  const seq = Number(input.seq);
  if (!Number.isInteger(seq) || seq < 0) {
    return { ok: false, code: "invalid_seq", message: "seq required" };
  }
  return { ok: true, seq };
}
