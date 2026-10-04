export const BODY_MAX = 2000;
export const SENDER_MAX = 64;
export const CLIENT_ID_MAX = 128;
export const HISTORY_LIMIT = 30;
export const HISTORY_PAGE_MAX = 50;
/**
 * Per-room hibernatable WebSocket cap.
 * Cloudflare hibernation supports up to 32,768 sockets per DO.
 * Custom/legacy rooms keep the Phase 1 200 cap.
 * Overall room (`all`) uses 800 to cover ~250 users × phone+PC + reconnect overlap.
 */
export const MAX_CONNECTIONS = 200;
export const MAX_CONNECTIONS_ALL = 800;
export const MAX_DIRECTORY_CONNECTIONS = 800;
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
export const MAX_MENTIONS = 20;
export const MAX_MENTION_RAW = 100;
export const MENTION_ALL_LABEL = "전체";
export const DELETE_FOR_EVERYONE_WINDOW_MS = 10 * 60 * 1000;
export const MESSAGE_RETENTION_DAYS = 180;
export const MESSAGE_RETENTION_MS = MESSAGE_RETENTION_DAYS * 24 * 60 * 60 * 1000;
export const RETENTION_ALARM_MS = 24 * 60 * 60 * 1000;
export const RETENTION_BATCH = 200;
export const SYNC_LIMIT = 100;
export const SYNC_PAGE_MAX = 100;
export const TOMBSTONE_EVERYONE = "메시지가 삭제되었습니다.";
export const TOMBSTONE_ADMIN = "관리자가 메시지를 삭제했습니다.";
export const REPLY_DELETED = "삭제된 메시지입니다.";
export const REPLY_EXPIRED = "보관기간이 지난 메시지입니다.";
export const DIRECTORY_TOMBSTONE_PREVIEW = "메시지가 삭제되었습니다.";

export type ChatSenderRole = "admin" | "caddy" | "leader";

export type ChatMention = { userId: number };

export type ChatDeletionType = "everyone" | "admin";

export type ChatReplyState = "ok" | "deleted" | "expired";

export type ChatReplyTo = {
  seq: number;
  senderUserId: number;
  sender: string;
  preview: string;
  state: ChatReplyState;
};

export type ChatMessage = {
  type: "message";
  clientMessageId: string;
  senderUserId: number;
  sender: string;
  senderRole: ChatSenderRole;
  body: string;
  sentAt: string;
  seq?: number;
  mentions: ChatMention[];
  mentionAll: boolean;
  replyToSeq?: number | null;
  replyTo?: ChatReplyTo | null;
  deletionType?: ChatDeletionType | null;
  deletedAt?: string | null;
};

export type SyncEvent = {
  type: "sync";
  messages: ChatMessage[];
  hasMore: boolean;
  newestSeq: number | null;
};

export type HiddenEvent = {
  type: "hidden";
  seq: number;
};

export type MessageDeletedEvent = {
  type: "message_deleted";
  seq: number;
  deletionType: ChatDeletionType;
  deletedAt: string;
  senderUserId: number;
  sender: string;
  senderRole: ChatSenderRole;
  sentAt: string;
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

export function clampReadSeq(requested: number, latestSeq: number): number {
  if (!Number.isInteger(requested) || requested < 0) return 0;
  if (!Number.isInteger(latestSeq) || latestSeq < 0) return 0;
  return Math.min(requested, latestSeq);
}

export function senderRoleFromClaims(role: string): ChatSenderRole {
  if (role === "admin") return "admin";
  if (role === "leader") return "leader";
  return "caddy";
}

export function canMentionAll(role: string | null | undefined): boolean {
  return role === "admin" || role === "leader";
}

export function normalizeMentionUserIds(raw: unknown): number[] {
  if (!Array.isArray(raw)) return [];
  if (raw.length > MAX_MENTION_RAW) return [];
  const out: number[] = [];
  const seen = new Set<number>();
  for (const item of raw) {
    const id =
      item != null && typeof item === "object" && "userId" in item
        ? Number((item as { userId: unknown }).userId)
        : Number(item);
    if (!Number.isInteger(id) || id <= 0) continue;
    if (seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= MAX_MENTIONS) break;
  }
  return out;
}

export function mentionsToWire(ids: unknown): ChatMention[] {
  return normalizeMentionUserIds(ids).map((userId) => ({ userId }));
}

export function resolveMentionAll(
  raw: unknown,
  senderRole: string | null | undefined
): boolean {
  return raw === true && canMentionAll(senderRole);
}

export function filterMentionsToMembers(
  ids: number[],
  memberIds: Iterable<number> | null | undefined
): number[] {
  if (memberIds == null) return normalizeMentionUserIds(ids);
  const allowed = new Set<number>();
  for (const id of memberIds) {
    if (Number.isInteger(id) && id > 0) allowed.add(id);
  }
  return normalizeMentionUserIds(ids).filter((id) => allowed.has(id));
}

export function parseStoredMentions(raw: unknown): ChatMention[] {
  if (raw == null || raw === "") return [];
  try {
    const parsed = typeof raw === "string" ? JSON.parse(raw) : raw;
    return mentionsToWire(normalizeMentionUserIds(parsed));
  } catch {
    return [];
  }
}

export function parseStoredMentionAll(raw: unknown): boolean {
  return raw === true || raw === 1 || raw === "1";
}

export function validateIncomingMessage(raw: unknown):
  | {
      ok: true;
      value: {
        clientMessageId: string;
        body: string;
        mentions: unknown;
        mentionAll: unknown;
      };
    }
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
  return {
    ok: true,
    value: {
      clientMessageId,
      body,
      mentions: input.mentions,
      mentionAll: input.mentionAll,
      replyToSeq: input.replyToSeq,
    },
  };
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

export function validateIncomingHistory(raw: unknown):
  | { ok: true; beforeSeq: number; limit: number }
  | { ok: false; code: string; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_payload", message: "JSON object required" };
  }
  const input = raw as Record<string, unknown>;
  if (input.type !== "history") {
    return { ok: false, code: "invalid_type", message: "type must be history" };
  }
  const beforeSeq = Number(input.beforeSeq);
  if (!Number.isInteger(beforeSeq) || beforeSeq <= 0) {
    return { ok: false, code: "invalid_seq", message: "beforeSeq required" };
  }
  const rawLimit = input.limit == null ? HISTORY_LIMIT : Number(input.limit);
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
    return { ok: false, code: "invalid_limit", message: "limit required" };
  }
  return { ok: true, beforeSeq, limit: Math.min(HISTORY_PAGE_MAX, rawLimit) };
}

export function parseOptionalSeq(raw: unknown): number | null {
  if (raw == null || raw === "") return null;
  const seq = Number(raw);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  return seq;
}

export function parseDeletionType(raw: unknown): ChatDeletionType | null {
  return raw === "everyone" || raw === "admin" ? raw : null;
}

export function tombstoneBody(deletionType: ChatDeletionType | null | undefined): string {
  if (deletionType === "admin") return TOMBSTONE_ADMIN;
  if (deletionType === "everyone") return TOMBSTONE_EVERYONE;
  return "";
}

export function directorySafePreview(input: {
  body?: string;
  deletionType?: ChatDeletionType | null;
}): string {
  if (input.deletionType) return DIRECTORY_TOMBSTONE_PREVIEW;
  return truncatePreview(String(input.body ?? ""));
}

export function canDeleteForEveryone(input: {
  actorUserId: number;
  senderUserId: number;
  sentAtMs: number;
  nowMs?: number;
  windowMs?: number;
}): boolean {
  if (!Number.isInteger(input.actorUserId) || input.actorUserId <= 0) return false;
  if (input.actorUserId !== input.senderUserId) return false;
  const now = input.nowMs ?? Date.now();
  const windowMs = input.windowMs ?? DELETE_FOR_EVERYONE_WINDOW_MS;
  return now - input.sentAtMs >= 0 && now - input.sentAtMs <= windowMs;
}

export function canAdminDelete(role: string | null | undefined): boolean {
  return role === "admin";
}

export function replyTargetFromRow(input: {
  replyToSeq: number | null;
  targetSeq: number | null;
  targetSenderUserId?: number | null;
  targetSender?: string | null;
  targetBody?: string | null;
  targetDeletionType?: unknown;
}): ChatReplyTo | null {
  if (input.replyToSeq == null) return null;
  if (input.targetSeq == null) {
    return {
      seq: input.replyToSeq,
      senderUserId: 0,
      sender: "",
      preview: REPLY_EXPIRED,
      state: "expired",
    };
  }
  const deletion = parseDeletionType(input.targetDeletionType);
  if (deletion) {
    return {
      seq: input.targetSeq,
      senderUserId: Number(input.targetSenderUserId || 0),
      sender: String(input.targetSender || ""),
      preview: REPLY_DELETED,
      state: "deleted",
    };
  }
  return {
    seq: input.targetSeq,
    senderUserId: Number(input.targetSenderUserId || 0),
    sender: String(input.targetSender || ""),
    preview: truncatePreview(String(input.targetBody || ""), 80),
    state: "ok",
  };
}

export function validateIncomingSync(raw: unknown):
  | { ok: true; afterSeq: number; limit: number }
  | { ok: false; code: string; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_payload", message: "JSON object required" };
  }
  const input = raw as Record<string, unknown>;
  if (input.type !== "sync") {
    return { ok: false, code: "invalid_type", message: "type must be sync" };
  }
  const afterSeq = Number(input.afterSeq);
  if (!Number.isInteger(afterSeq) || afterSeq < 0) {
    return { ok: false, code: "invalid_seq", message: "afterSeq required" };
  }
  const rawLimit = input.limit == null ? SYNC_LIMIT : Number(input.limit);
  if (!Number.isInteger(rawLimit) || rawLimit <= 0) {
    return { ok: false, code: "invalid_limit", message: "limit required" };
  }
  return { ok: true, afterSeq, limit: Math.min(SYNC_PAGE_MAX, rawLimit) };
}

export function validateIncomingHide(raw: unknown):
  | { ok: true; seq: number }
  | { ok: false; code: string; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_payload", message: "JSON object required" };
  }
  const input = raw as Record<string, unknown>;
  if (input.type !== "hide") {
    return { ok: false, code: "invalid_type", message: "type must be hide" };
  }
  const seq = Number(input.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    return { ok: false, code: "invalid_seq", message: "seq required" };
  }
  return { ok: true, seq };
}

export function validateIncomingDelete(raw: unknown):
  | { ok: true; seq: number; mode: "everyone" | "admin" }
  | { ok: false; code: string; message: string } {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) {
    return { ok: false, code: "invalid_payload", message: "JSON object required" };
  }
  const input = raw as Record<string, unknown>;
  if (input.type !== "delete") {
    return { ok: false, code: "invalid_type", message: "type must be delete" };
  }
  const seq = Number(input.seq);
  if (!Number.isInteger(seq) || seq <= 0) {
    return { ok: false, code: "invalid_seq", message: "seq required" };
  }
  if (input.mode !== "everyone" && input.mode !== "admin") {
    return { ok: false, code: "invalid_mode", message: "mode required" };
  }
  return { ok: true, seq, mode: input.mode };
}
