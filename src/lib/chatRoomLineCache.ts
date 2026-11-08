/**
 * Session-memory cache of recently opened room lines.
 * Paints last-visit messages immediately on re-open, then ChatClient
 * replaces them with the server history page. Not persisted. Logout /
 * account switch wipes it. Worker still authorizes the socket.
 */
import { isChatSessionEnded, subscribeChatSessionReset } from "./chatSessionReset";
import type { ChatLineBase } from "./chatPhase4";
import type { ChatAttachment } from "../../cloudflare/verthill-chat/src/protocol";

export const CHAT_ROOM_LINE_CACHE_TTL_MS = 10 * 60 * 1000;
export const CHAT_ROOM_LINE_CACHE_MAX_ROOMS = 8;
export const CHAT_ROOM_LINE_CACHE_MAX_LINES = 50;

export type CachedChatRoomLine = ChatLineBase & { status: "sent" };

export type ChatRoomLineCachePage = {
  userId: number;
  roomId: string;
  storedAt: number;
  hasMore: boolean;
  oldestSeq: number | null;
  hiddenSeqs: number[];
  lines: CachedChatRoomLine[];
};

export type ChatRoomLineCacheInput = {
  lines: unknown;
  hasMore?: boolean;
  oldestSeq?: number | null;
  hiddenSeqs?: Iterable<number>;
};

export type ChatRoomPaintTiming = {
  paintedFromCache: boolean;
  cachePaintMs: number | null;
  historyMs: number | null;
};

type RoomKey = string;

const rooms = new Map<RoomKey, ChatRoomLineCachePage>();
let subscribed = false;
let openStartedAt: number | null = null;
let paint: ChatRoomPaintTiming = {
  paintedFromCache: false,
  cachePaintMs: null,
  historyMs: null,
};

function nowMs(): number {
  try {
    return Date.now();
  } catch {
    return 0;
  }
}

function roomKey(userId: number, roomId: string): RoomKey {
  return `${userId}:${roomId}`;
}

function ensureSubscribed(): void {
  if (subscribed || typeof window === "undefined") return;
  subscribed = true;
  try {
    subscribeChatSessionReset(() => clearChatRoomLineCache());
  } catch {
    // no-op
  }
}

function asFiniteId(v: unknown): number | null {
  const n = Number(v);
  return Number.isInteger(n) && n > 0 ? n : null;
}

function asRoomId(v: unknown): string | null {
  const s = String(v || "").trim();
  return s && s.length <= 80 ? s : null;
}

function asHiddenSeqs(raw: Iterable<number> | undefined): number[] {
  if (!raw) return [];
  const out: number[] = [];
  for (const item of raw) {
    const n = Number(item);
    if (Number.isInteger(n) && n > 0 && !out.includes(n)) out.push(n);
    if (out.length >= CHAT_ROOM_LINE_CACHE_MAX_LINES) break;
  }
  return out;
}

function sanitizeAttachment(raw: unknown): ChatAttachment | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as Record<string, unknown>;
  if ("claim" in rec || "authorization" in rec || "token" in rec) return null;
  const id = String(rec.id || "").trim();
  const mimeType = String(rec.mimeType || "").trim();
  const size = Number(rec.size);
  if (!id || id.length > 80) return null;
  return {
    id,
    mimeType: mimeType || "application/octet-stream",
    size: Number.isFinite(size) && size >= 0 ? size : 0,
  };
}

function sanitizeReply(raw: unknown): CachedChatRoomLine["replyTo"] {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const rec = raw as {
    seq?: unknown;
    senderUserId?: unknown;
    sender?: unknown;
    preview?: unknown;
    state?: unknown;
  };
  const seq = Number(rec.seq);
  if (!Number.isInteger(seq) || seq <= 0) return null;
  const state = rec.state === "deleted" || rec.state === "expired" ? rec.state : "ok";
  return {
    seq,
    senderUserId: asFiniteId(rec.senderUserId) || 0,
    sender: String(rec.sender || "").slice(0, 80),
    preview: String(rec.preview || "").slice(0, 80),
    state,
  };
}

export function sanitizeChatRoomLinesForCache(raw: unknown): CachedChatRoomLine[] {
  if (!Array.isArray(raw)) return [];
  const out: CachedChatRoomLine[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    if (rec.status === "sending" || rec.status === "failed") continue;
    const clientMessageId = String(rec.clientMessageId || "").trim();
    if (!clientMessageId || clientMessageId.length > 80) continue;
    const senderUserId = asFiniteId(rec.senderUserId);
    if (!senderUserId) continue;
    const seqRaw = rec.seq;
    const seq = seqRaw == null ? undefined : Number(seqRaw);
    if (seq != null && (!Number.isInteger(seq) || seq <= 0)) continue;
    const mentions = Array.isArray(rec.mentions)
      ? rec.mentions.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0).slice(0, 40)
      : [];
    const attachments = Array.isArray(rec.attachments)
      ? rec.attachments.map(sanitizeAttachment).filter((row): row is NonNullable<typeof row> => Boolean(row)).slice(0, 8)
      : undefined;
    const deletionType = rec.deletionType === "admin" || rec.deletionType === "everyone" ? rec.deletionType : null;
    out.push({
      clientMessageId,
      senderUserId,
      sender: String(rec.sender || "").slice(0, 80),
      senderRole: String(rec.senderRole || "").slice(0, 32),
      body: String(rec.body || "").slice(0, 4000),
      sentAt: String(rec.sentAt || ""),
      seq,
      mentions,
      mentionAll: rec.mentionAll === true,
      attachments: attachments?.length ? attachments : undefined,
      replyToSeq: Number.isInteger(Number(rec.replyToSeq)) && Number(rec.replyToSeq) > 0 ? Number(rec.replyToSeq) : null,
      replyTo: sanitizeReply(rec.replyTo),
      deletionType,
      deletedAt: rec.deletedAt ? String(rec.deletedAt).slice(0, 40) : null,
      status: "sent",
    });
  }
  return out.slice(-CHAT_ROOM_LINE_CACHE_MAX_LINES);
}

export function clearChatRoomLineCache(): void {
  rooms.clear();
  openStartedAt = null;
  paint = { paintedFromCache: false, cachePaintMs: null, historyMs: null };
}

export function rememberChatRoomLines(
  userId: number | null | undefined,
  roomId: string | null | undefined,
  input: ChatRoomLineCacheInput
): boolean {
  ensureSubscribed();
  const uid = asFiniteId(userId);
  const rid = asRoomId(roomId);
  if (isChatSessionEnded()) {
    rooms.clear();
    return false;
  }
  if (!uid || !rid) return false;
  const lines = sanitizeChatRoomLinesForCache(input.lines);
  if (!lines.length) {
    rooms.delete(roomKey(uid, rid));
    return false;
  }
  const key = roomKey(uid, rid);
  rooms.delete(key);
  rooms.set(key, {
    userId: uid,
    roomId: rid,
    storedAt: nowMs(),
    hasMore: input.hasMore === true,
    oldestSeq: typeof input.oldestSeq === "number" && Number.isFinite(input.oldestSeq) ? input.oldestSeq : null,
    hiddenSeqs: asHiddenSeqs(input.hiddenSeqs),
    lines,
  });
  while (rooms.size > CHAT_ROOM_LINE_CACHE_MAX_ROOMS) {
    const oldest = rooms.keys().next().value;
    if (oldest == null) break;
    rooms.delete(oldest);
  }
  return true;
}

export function readCachedChatRoomLines(
  userId: number | null | undefined,
  roomId: string | null | undefined,
  now = nowMs()
): ChatRoomLineCachePage | null {
  ensureSubscribed();
  const uid = asFiniteId(userId);
  const rid = asRoomId(roomId);
  if (isChatSessionEnded()) {
    rooms.clear();
    return null;
  }
  if (!uid || !rid) return null;
  const page = rooms.get(roomKey(uid, rid));
  if (!page || page.userId !== uid || page.roomId !== rid) return null;
  if (!Number.isFinite(page.storedAt) || now - page.storedAt > CHAT_ROOM_LINE_CACHE_TTL_MS || now < page.storedAt) {
    rooms.delete(roomKey(uid, rid));
    return null;
  }
  if (!page.lines.length) return null;
  rooms.delete(roomKey(uid, rid));
  rooms.set(roomKey(uid, rid), page);
  return {
    ...page,
    hiddenSeqs: page.hiddenSeqs.slice(),
    lines: page.lines.map((line) => ({ ...line, attachments: line.attachments?.slice(), mentions: line.mentions.slice() })),
  };
}

export function dropCachedChatRoom(
  userId: number | null | undefined,
  roomId: string | null | undefined
): void {
  const uid = asFiniteId(userId);
  const rid = asRoomId(roomId);
  if (!uid || !rid) return;
  rooms.delete(roomKey(uid, rid));
}

/**
 * Cache may paint only after the Worker/DO accepted this socket.
 * New WS: browser `open` means ChatRoom `authorizeSocket` returned 101
 * (session-check + membership). Parked resume has no earlier frame than
 * `{type:"history"}` — do not use the list cache or token TTL as auth.
 */
export function shouldPaintCachedChatRoomLines(input: {
  serverSocketAuthorized: boolean;
}): boolean {
  return input.serverSocketAuthorized === true && !isChatSessionEnded();
}

/** Drop this user's cached rooms that are no longer in the directory snapshot. */
export function retainCachedChatRooms(
  userId: number | null | undefined,
  allowedRoomIds: Iterable<string>
): number {
  const uid = asFiniteId(userId);
  if (!uid) return 0;
  const allowed = new Set<string>();
  for (const id of allowedRoomIds) {
    const rid = asRoomId(id);
    if (rid) allowed.add(rid);
  }
  let dropped = 0;
  for (const [key, page] of [...rooms.entries()]) {
    if (page.userId !== uid) continue;
    if (allowed.has(page.roomId)) continue;
    rooms.delete(key);
    dropped += 1;
  }
  return dropped;
}

export function shouldShowChatHistoryWait(input: {
  lineCount: number;
  lastMessageSeq: number | null | undefined;
}): boolean {
  const seq = Number(input.lastMessageSeq);
  return input.lineCount === 0 && Number.isInteger(seq) && seq > 0;
}

export function markChatRoomOpenStarted(now = nowMs()): void {
  openStartedAt = now;
  paint = { paintedFromCache: false, cachePaintMs: null, historyMs: null };
}

export function markChatRoomCachePainted(now = nowMs()): number | null {
  if (openStartedAt == null || paint.cachePaintMs != null) return paint.cachePaintMs;
  paint.cachePaintMs = Math.max(0, Math.round(now - openStartedAt));
  paint.paintedFromCache = true;
  return paint.cachePaintMs;
}

export function markChatRoomHistoryPainted(now = nowMs()): number | null {
  if (openStartedAt == null || paint.historyMs != null) return paint.historyMs;
  paint.historyMs = Math.max(0, Math.round(now - openStartedAt));
  return paint.historyMs;
}

export function getChatRoomPaintTiming(): ChatRoomPaintTiming {
  return { ...paint };
}

export function resetChatRoomLineCacheForTests(): void {
  rooms.clear();
  subscribed = false;
  openStartedAt = null;
  paint = { paintedFromCache: false, cachePaintMs: null, historyMs: null };
}

export function chatRoomLineCacheSizeForTests(): number {
  return rooms.size;
}
