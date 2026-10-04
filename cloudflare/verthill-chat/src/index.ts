import { DurableObject } from "cloudflare:workers";
import { ChatDirectory } from "./directory";
import {
  chatInternalSecret,
  internalAuthHeaders,
  verifyInternalRequest,
} from "./internalAuth";
import {
  DIRECTORY_NAME,
  DIRECTORY_TOMBSTONE_PREVIEW,
  HISTORY_LIMIT,
  MAX_CONNECTIONS,
  MAX_CONNECTIONS_ALL,
  MESSAGE_MAX,
  MESSAGE_RETENTION_MS,
  REPLY_DELETED,
  RETENTION_ALARM_MS,
  RETENTION_BATCH,
  canAdminDelete,
  canDeleteForEveryone,
  clampSyncAfterSeq,
  directorySafePreview,
  filterMentionsToMembers,
  isAllRoomId,
  isCustomRoomId,
  isLegacyTeamRoomId,
  isValidRoomName,
  mentionsToWire,
  parseDeletionType,
  parseOptionalSeq,
  parseStoredMentionAll,
  parseStoredMentions,
  replyTargetFromRow,
  resolveMentionAll,
  senderRoleFromClaims,
  validateIncomingDelete,
  validateIncomingHide,
  validateIncomingHistory,
  validateIncomingMessage,
  validateIncomingRead,
  validateIncomingSync,
  type ChatDeletionType,
  type ChatMessage,
  type MessageDeletedEvent,
} from "./protocol";
import {
  resolveChatRoomAccess,
  verifyChatToken,
  type ChatTokenClaims,
} from "./token";

export { validateIncomingMessage, isValidRoomName } from "./protocol";
export { verifyChatToken } from "./token";
export { ChatDirectory };

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
  CHAT_DIRECTORY: DurableObjectNamespace<ChatDirectory>;
  CHAT_AUTH_SECRET: string;
  CHAT_INTERNAL_SECRET?: string;
}

function corsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization",
    "access-control-allow-methods": "GET, POST, OPTIONS",
  };
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...corsHeaders(),
    },
  });
}

function sendJson(ws: WebSocket, data: unknown) {
  ws.send(JSON.stringify(data));
}

function directoryStub(env: Env) {
  return env.CHAT_DIRECTORY.get(env.CHAT_DIRECTORY.idFromName(DIRECTORY_NAME));
}

async function verifyIdentity(
  request: Request,
  env: Env
): Promise<ChatTokenClaims | Response> {
  const url = new URL(request.url);
  const secret = String(env.CHAT_AUTH_SECRET || "").trim();
  if (!secret) return json({ error: "chat_auth_unconfigured" }, 503);
  const header = (request.headers.get("authorization") || "").trim();
  const bearer = header.toLowerCase().startsWith("bearer ")
    ? header.slice(7).trim()
    : "";
  const token = (url.searchParams.get("token") || bearer).trim();
  if (!token) return json({ error: "unauthorized" }, 401);
  const claims = await verifyChatToken(token, secret);
  if (!claims) return json({ error: "invalid_token" }, 401);
  return claims;
}

async function listDirectoryMemberIds(env: Env, roomId: string): Promise<number[] | null> {
  const path = "/internal/member-ids";
  const headers = await internalAuthHeaders(chatInternalSecret(env), path);
  const res = await directoryStub(env).fetch(
    new Request(
      `https://chat-directory${path}?room=${encodeURIComponent(roomId)}`,
      { headers }
    )
  );
  if (!res.ok) return null;
  const data = (await res.json()) as { ids?: unknown };
  if (!Array.isArray(data.ids)) return [];
  return data.ids.map((id) => Number(id)).filter((id) => Number.isInteger(id) && id > 0);
}

async function isDirectoryMember(
  env: Env,
  roomId: string,
  userId: number
): Promise<boolean> {
  const path = "/internal/member";
  const headers = await internalAuthHeaders(chatInternalSecret(env), path);
  const res = await directoryStub(env).fetch(
    new Request(
      `https://chat-directory${path}?room=${encodeURIComponent(roomId)}&userId=${userId}`,
      { headers }
    )
  );
  if (!res.ok) return false;
  const data = (await res.json()) as { member?: boolean };
  return data.member === true;
}

async function authorizeSocket(
  request: Request,
  env: Env
): Promise<{ room: string; claims: ChatTokenClaims } | Response> {
  const url = new URL(request.url);
  const room = (url.searchParams.get("room") || "").trim();
  if (!isValidRoomName(room)) {
    return json({ error: "invalid_room" }, 400);
  }
  const identity = await verifyIdentity(request, env);
  if (identity instanceof Response) return identity;
  const access = resolveChatRoomAccess({
    claims: identity,
    roomId: room,
    isMember: isCustomRoomId(room)
      ? await isDirectoryMember(env, room, identity.userId)
      : isAllRoomId(room),
    isAll: isAllRoomId(room),
    isCustom: isCustomRoomId(room),
    isLegacy: isLegacyTeamRoomId(room),
  });
  if (!access.ok) {
    const code = access.code === "invalid_room" ? "invalid_room" : "room_forbidden";
    return json({ error: code }, code === "invalid_room" ? 400 : 403);
  }
  return { room, claims: identity };
}

async function forwardDirectory(request: Request, env: Env): Promise<Response> {
  const identity = await verifyIdentity(request, env);
  if (identity instanceof Response) return identity;
  // Must keep the inbound Request object. Rebuilding Request(url, {headers, body})
  // drops Cloudflare's WebSocket upgrade binding — ChatRoom works because it
  // forwards `request` unchanged. Directory list/WS used the rebuilt Request.
  const forwarded = new Request(request.url, request);
  forwarded.headers.set("x-chat-claims", JSON.stringify(identity));
  return directoryStub(env).fetch(forwarded);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "verthill-chat" });
    }
    if (url.pathname === "/ws") {
      const authorized = await authorizeSocket(request, env);
      if (authorized instanceof Response) return authorized;
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      const id = env.CHAT_ROOM.idFromName(authorized.room);
      return env.CHAT_ROOM.get(id).fetch(request);
    }
    if (url.pathname === "/directory/ws") {
      return forwardDirectory(request, env);
    }
    if (request.method === "GET" && url.pathname === "/directory/rooms") {
      return forwardDirectory(request, env);
    }
    const membersMatch = /^\/directory\/rooms\/([^/]+)\/members$/.exec(url.pathname);
    if (request.method === "GET" && membersMatch) {
      return forwardDirectory(request, env);
    }
    if (request.method === "POST" && url.pathname === "/directory/rooms") {
      return createRoomFromGrant(request, env);
    }
    return json({ error: "not_found" }, 404);
  },
};

async function createRoomFromGrant(request: Request, env: Env): Promise<Response> {
  if (request.headers.get("origin")) {
    return json({ error: "server_only" }, 403);
  }
  const secret = chatInternalSecret(env);
  if (!secret) return json({ error: "chat_auth_unconfigured" }, 503);
  let body: { grant?: string };
  try {
    body = (await request.json()) as { grant?: string };
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const grant = await verifyCreateGrant(String(body.grant || ""), secret);
  if (!grant) return json({ error: "invalid_grant" }, 401);
  const headers = await internalAuthHeaders(secret, "/internal/create");
  return directoryStub(env).fetch(
    new Request("https://chat-directory/internal/create", {
      method: "POST",
      headers,
      body: JSON.stringify({
        roomId: grant.roomId,
        name: grant.name,
        ownerUserId: grant.ownerUserId,
        members: grant.members,
      }),
    })
  );
}

type CreateGrant = {
  v: 1;
  op: "create_room";
  roomId: string;
  name: string;
  ownerUserId: number;
  members: { userId: number; displayName: string; role: string; team: string }[];
  iat: number;
  exp: number;
};

function canonicalGrant(grant: CreateGrant): string {
  const members = grant.members
    .map((m) => `${m.userId}:${m.displayName}:${m.role}:${m.team}`)
    .sort()
    .join(",");
  return [
    String(grant.v),
    grant.op,
    grant.roomId,
    grant.name,
    String(grant.ownerUserId),
    members,
    String(grant.iat),
    String(grant.exp),
  ].join("|");
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

async function verifyCreateGrant(
  token: string,
  secret: string
): Promise<CreateGrant | null> {
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let payload: string;
  try {
    payload = new TextDecoder().decode(
      Uint8Array.from(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")), (c) =>
        c.charCodeAt(0)
      )
    );
  } catch {
    try {
      const pad = parts[0].length % 4 === 0 ? "" : "=".repeat(4 - (parts[0].length % 4));
      payload = new TextDecoder().decode(
        Uint8Array.from(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/") + pad), (c) =>
          c.charCodeAt(0)
        )
      );
    } catch {
      return null;
    }
  }
  let grant: CreateGrant;
  try {
    grant = JSON.parse(payload) as CreateGrant;
  } catch {
    return null;
  }
  if (grant.v !== 1 || grant.op !== "create_room") return null;
  const canonical = canonicalGrant(grant);
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(canonical))
  );
  let got: Uint8Array;
  try {
    const pad = parts[1].length % 4 === 0 ? "" : "=".repeat(4 - (parts[1].length % 4));
    const bin = atob(parts[1].replace(/-/g, "+").replace(/_/g, "/") + pad);
    got = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
  if (!timingSafeEqualBytes(expected, got)) return null;
  const now = Math.floor(Date.now() / 1000);
  if (grant.exp <= now || grant.iat > now + 30) return null;
  return grant;
}

type SocketAttach = { claims: ChatTokenClaims; roomId: string };

export class ChatRoom extends DurableObject<Env> {
  private persistQueue: Promise<void> = Promise.resolve();

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        client_message_id TEXT NOT NULL UNIQUE,
        sender_user_id INTEGER NOT NULL DEFAULT 0,
        sender TEXT NOT NULL,
        sender_role TEXT NOT NULL DEFAULT 'caddy',
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL,
        mentions_json TEXT NOT NULL DEFAULT '[]',
        mention_all INTEGER NOT NULL DEFAULT 0
      )
    `);
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN sender_user_id INTEGER NOT NULL DEFAULT 0`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN sender_role TEXT NOT NULL DEFAULT 'caddy'`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN mentions_json TEXT NOT NULL DEFAULT '[]'`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(
        `ALTER TABLE messages ADD COLUMN mention_all INTEGER NOT NULL DEFAULT 0`
      );
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN reply_to_seq INTEGER`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN deleted_at TEXT`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN deletion_type TEXT`);
    } catch {
      // already present
    }
    try {
      this.ctx.storage.sql.exec(`ALTER TABLE messages ADD COLUMN deleted_by_user_id INTEGER`);
    } catch {
      // already present
    }
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS hidden_messages (
        user_id INTEGER NOT NULL,
        seq INTEGER NOT NULL,
        hidden_at TEXT NOT NULL,
        PRIMARY KEY (user_id, seq)
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq)`
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_sent_at ON messages(sent_at)`
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_reply_to ON messages(reply_to_seq)`
    );
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS hidden_messages_user ON hidden_messages(user_id)`
    );
    void this.ensureRetentionAlarm();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "POST" && url.pathname === "/internal/retention") {
      if (!(await verifyInternalRequest(request, this.env, url.pathname))) {
        return json({ error: "forbidden" }, 403);
      }
      await this.ensureRetentionAlarm();
      this.purgeExpiredMessages(RETENTION_BATCH);
      return json({ ok: true });
    }
    const authorized = await authorizeSocket(request, this.env);
    if (authorized instanceof Response) return authorized;
    const cap = isAllRoomId(authorized.room) ? MAX_CONNECTIONS_ALL : MAX_CONNECTIONS;
    if (this.ctx.getWebSockets().length >= cap) {
      return json({ error: "room_full" }, 503);
    }
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    const attach: SocketAttach = { claims: authorized.claims, roomId: authorized.room };
    server.serializeAttachment(attach);
    this.sendHistory(server, authorized.claims.userId, null, HISTORY_LIMIT);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const attach = this.readAttach(ws);
    if (!attach) return;
    if (typeof message !== "string") {
      sendJson(ws, {
        type: "error",
        code: "invalid_payload",
        message: "text JSON required",
      });
      return;
    }
    if (message.length > MESSAGE_MAX) {
      sendJson(ws, {
        type: "error",
        code: "payload_too_large",
        message: `payload max ${MESSAGE_MAX}`,
      });
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      sendJson(ws, {
        type: "error",
        code: "invalid_payload",
        message: "malformed JSON",
      });
      return;
    }
    const type =
      parsed && typeof parsed === "object" ? String((parsed as { type?: unknown }).type || "") : "";
    if (type === "read") {
      const read = validateIncomingRead(parsed);
      if (!read.ok) {
        sendJson(ws, { type: "error", code: read.code, message: read.message });
        return;
      }
      void this.notifyDirectoryRead(attach.roomId, attach.claims.userId, read.seq);
      return;
    }
    if (type === "history") {
      const hist = validateIncomingHistory(parsed);
      if (!hist.ok) {
        sendJson(ws, { type: "error", code: hist.code, message: hist.message });
        return;
      }
      this.sendHistory(ws, attach.claims.userId, hist.beforeSeq, hist.limit);
      return;
    }
    if (type === "sync") {
      const sync = validateIncomingSync(parsed);
      if (!sync.ok) {
        sendJson(ws, { type: "error", code: sync.code, message: sync.message });
        return;
      }
      this.sendSync(ws, attach.claims.userId, sync.afterSeq, sync.limit);
      return;
    }
    if (type === "hide") {
      const hide = validateIncomingHide(parsed);
      if (!hide.ok) {
        sendJson(ws, { type: "error", code: hide.code, message: hide.message });
        return;
      }
      this.persistQueue = this.persistQueue
        .then(() => this.hideForMe(ws, attach, hide.seq))
        .catch(() => undefined);
      return;
    }
    if (type === "delete") {
      const del = validateIncomingDelete(parsed);
      if (!del.ok) {
        sendJson(ws, { type: "error", code: del.code, message: del.message });
        return;
      }
      this.persistQueue = this.persistQueue
        .then(() => this.deleteMessage(ws, attach, del.seq, del.mode))
        .catch(() => undefined);
      return;
    }
    const checked = validateIncomingMessage(parsed);
    if (!checked.ok) {
      sendJson(ws, {
        type: "error",
        code: checked.code,
        message: checked.message,
      });
      return;
    }
    this.persistQueue = this.persistQueue
      .then(() => this.persistMessage(ws, attach, checked.value))
      .catch(() => undefined);
  }

  private async persistMessage(
    ws: WebSocket,
    attach: SocketAttach,
    value: {
      clientMessageId: string;
      body: string;
      mentions: unknown;
      mentionAll: unknown;
      replyToSeq: unknown;
    }
  ) {
    const sentAt = new Date().toISOString();
    const existing = this.ctx.storage.sql
      .exec(
        `SELECT seq FROM messages WHERE client_message_id = ?`,
        value.clientMessageId
      )
      .toArray();
    if (existing.length > 0) {
      sendJson(ws, {
        type: "duplicate",
        clientMessageId: value.clientMessageId,
      });
      return;
    }

    const senderRole = senderRoleFromClaims(attach.claims.role);
    const mentionAll = resolveMentionAll(value.mentionAll, senderRole);
    let mentionIds = mentionsToWire(value.mentions).map((m) => m.userId);
    if (isCustomRoomId(attach.roomId) && mentionIds.length > 0) {
      const memberIds = await listDirectoryMemberIds(this.env, attach.roomId);
      mentionIds = filterMentionsToMembers(mentionIds, memberIds ?? []);
    }
    const mentions = mentionsToWire(mentionIds);
    const replyToSeq = parseOptionalSeq(value.replyToSeq);
    if (value.replyToSeq != null && value.replyToSeq !== "" && replyToSeq == null) {
      sendJson(ws, { type: "error", code: "invalid_reply", message: "replyToSeq required" });
      return;
    }
    if (replyToSeq != null) {
      const target = this.ctx.storage.sql
        .exec(`SELECT seq FROM messages WHERE seq = ?`, replyToSeq)
        .toArray();
      if (target.length === 0) {
        sendJson(ws, { type: "error", code: "reply_missing", message: "reply target missing" });
        return;
      }
    }

    this.ctx.storage.sql.exec(
      `INSERT INTO messages
        (client_message_id, sender_user_id, sender, sender_role, body, sent_at, mentions_json, mention_all, reply_to_seq)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      value.clientMessageId,
      attach.claims.userId,
      attach.claims.displayName,
      senderRole,
      value.body,
      sentAt,
      JSON.stringify(mentions),
      mentionAll ? 1 : 0,
      replyToSeq
    );
    const inserted = this.loadMessageByClientId(value.clientMessageId);
    if (!inserted) return;
    this.broadcastVisible(inserted);
    void this.notifyDirectoryMessage(attach.roomId, inserted);
  }

  webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000, "closed");
    } catch {
      // already closed
    }
  }

  webSocketError(ws: WebSocket) {
    try {
      ws.close(1011, "error");
    } catch {
      // already closed
    }
  }

  private readAttach(ws: WebSocket): SocketAttach | null {
    const raw = ws.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
    if (!raw) return this.expire(ws);
    if ("claims" in raw && raw.claims) {
      if (raw.claims.exp <= Math.floor(Date.now() / 1000)) return this.expire(ws);
      return raw;
    }
    const claims = raw as ChatTokenClaims;
    if (claims.exp <= Math.floor(Date.now() / 1000)) return this.expire(ws);
    return { claims, roomId: claims.v === 1 ? claims.room : "" };
  }

  private expire(ws: WebSocket): null {
    sendJson(ws, {
      type: "error",
      code: "expired_token",
      message: "token expired",
    });
    try {
      ws.close(4008, "expired_token");
    } catch {
      // ignore
    }
    return null;
  }

  private messageSelectSql() {
    return `SELECT m.seq, m.client_message_id, m.sender_user_id, m.sender, m.sender_role,
              m.body, m.sent_at, m.mentions_json, m.mention_all, m.reply_to_seq,
              m.deleted_at, m.deletion_type,
              r.seq AS reply_seq, r.sender_user_id AS reply_sender_user_id,
              r.sender AS reply_sender, r.body AS reply_body,
              r.deletion_type AS reply_deletion_type,
              rh.seq AS reply_hidden
            FROM messages m
            LEFT JOIN hidden_messages h ON h.user_id = ? AND h.seq = m.seq
            LEFT JOIN messages r ON r.seq = m.reply_to_seq
            LEFT JOIN hidden_messages rh ON rh.user_id = ? AND rh.seq = m.reply_to_seq
            WHERE h.seq IS NULL`;
  }

  private rowToMessage(row: Record<string, unknown>): ChatMessage {
    const deletionType = parseDeletionType(row.deletion_type);
    const replyToSeq = parseOptionalSeq(row.reply_to_seq);
    return {
      type: "message",
      clientMessageId: String(row.client_message_id),
      senderUserId: Number(row.sender_user_id || 0),
      sender: String(row.sender),
      senderRole: senderRoleFromClaims(String(row.sender_role || "caddy")),
      body: deletionType ? "" : String(row.body || ""),
      sentAt: String(row.sent_at),
      seq: Number(row.seq),
      mentions: deletionType ? [] : parseStoredMentions(row.mentions_json),
      mentionAll: deletionType ? false : parseStoredMentionAll(row.mention_all),
      replyToSeq,
      replyTo: replyTargetFromRow({
        replyToSeq,
        targetSeq: parseOptionalSeq(row.reply_seq),
        targetSenderUserId: Number(row.reply_sender_user_id || 0),
        targetSender: row.reply_sender == null ? "" : String(row.reply_sender),
        targetBody: row.reply_body == null ? "" : String(row.reply_body),
        targetDeletionType: row.reply_deletion_type,
        targetHidden: row.reply_hidden != null && row.reply_hidden !== "",
      }),
      deletionType,
      deletedAt: row.deleted_at ? String(row.deleted_at) : null,
    };
  }

  private loadMessageByClientId(clientMessageId: string): ChatMessage | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT m.seq, m.client_message_id, m.sender_user_id, m.sender, m.sender_role,
                m.body, m.sent_at, m.mentions_json, m.mention_all, m.reply_to_seq,
                m.deleted_at, m.deletion_type,
                r.seq AS reply_seq, r.sender_user_id AS reply_sender_user_id,
                r.sender AS reply_sender, r.body AS reply_body,
                r.deletion_type AS reply_deletion_type
         FROM messages m
         LEFT JOIN messages r ON r.seq = m.reply_to_seq
         WHERE m.client_message_id = ?`,
        clientMessageId
      )
      .toArray()[0];
    return row ? this.rowToMessage(row) : null;
  }

  private sendHistory(ws: WebSocket, userId: number, beforeSeq: number | null, limit: number) {
    const rows =
      beforeSeq == null
        ? this.ctx.storage.sql
            .exec(
              `${this.messageSelectSql()}
               ORDER BY m.seq DESC
               LIMIT ?`,
              userId,
              userId,
              limit
            )
            .toArray()
        : this.ctx.storage.sql
            .exec(
              `${this.messageSelectSql()}
               AND m.seq < ?
               ORDER BY m.seq DESC
               LIMIT ?`,
              userId,
              userId,
              beforeSeq,
              limit
            )
            .toArray();
    rows.reverse();
    const messages = rows.map((row) => this.rowToMessage(row));
    const oldestSeq = messages.length ? Number(messages[0]!.seq) : null;
    let hasMore = false;
    if (oldestSeq != null) {
      const older = this.ctx.storage.sql
        .exec(
          `SELECT 1 AS ok FROM messages m
           LEFT JOIN hidden_messages h ON h.user_id = ? AND h.seq = m.seq
           WHERE h.seq IS NULL AND m.seq < ?
           LIMIT 1`,
          userId,
          oldestSeq
        )
        .toArray();
      hasMore = older.length > 0;
    }
    sendJson(ws, {
      type: "history",
      messages,
      hasMore,
      oldestSeq,
    });
  }

  private sendSync(ws: WebSocket, userId: number, afterSeq: number, limit: number) {
    const maxRow = this.ctx.storage.sql
      .exec(`SELECT MAX(seq) AS max_seq FROM messages`)
      .toArray()[0];
    const after = clampSyncAfterSeq(afterSeq, Number(maxRow?.max_seq || 0));
    const rows = this.ctx.storage.sql
      .exec(
        `${this.messageSelectSql()}
         AND m.seq > ?
         ORDER BY m.seq ASC
         LIMIT ?`,
        userId,
        userId,
        after,
        limit
      )
      .toArray();
    const messages = rows.map((row) => this.rowToMessage(row));
    const newestSeq = messages.length ? Number(messages[messages.length - 1]!.seq) : after;
    const newer = this.ctx.storage.sql
      .exec(
        `SELECT 1 AS ok FROM messages m
         LEFT JOIN hidden_messages h ON h.user_id = ? AND h.seq = m.seq
         WHERE h.seq IS NULL AND m.seq > ?
         LIMIT 1`,
        userId,
        newestSeq
      )
      .toArray();
    sendJson(ws, {
      type: "sync",
      messages,
      hasMore: newer.length > 0,
      newestSeq,
    });
  }

  private hideForMe(ws: WebSocket, attach: SocketAttach, seq: number) {
    const exists = this.ctx.storage.sql
      .exec(`SELECT seq FROM messages WHERE seq = ?`, seq)
      .toArray();
    if (exists.length === 0) {
      sendJson(ws, { type: "error", code: "hide_missing", message: "message missing" });
      return;
    }
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO hidden_messages (user_id, seq, hidden_at) VALUES (?, ?, ?)`,
      attach.claims.userId,
      seq,
      new Date().toISOString()
    );
    this.sendToUser(attach.claims.userId, { type: "hidden", seq });
  }

  private deleteMessage(
    ws: WebSocket,
    attach: SocketAttach,
    seq: number,
    mode: "everyone" | "admin"
  ) {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT seq, sender_user_id, sender, sender_role, sent_at, deletion_type
         FROM messages WHERE seq = ?`,
        seq
      )
      .toArray()[0];
    if (!row) {
      sendJson(ws, { type: "error", code: "delete_missing", message: "message missing" });
      return;
    }
    if (parseDeletionType(row.deletion_type)) {
      sendJson(ws, { type: "error", code: "already_deleted", message: "already deleted" });
      return;
    }
    const senderUserId = Number(row.sender_user_id || 0);
    const sentAtMs = new Date(String(row.sent_at)).getTime();
    if (mode === "admin") {
      if (!canAdminDelete(attach.claims.role)) {
        sendJson(ws, { type: "error", code: "forbidden", message: "admin only" });
        return;
      }
    } else if (
      !canDeleteForEveryone({
        actorUserId: attach.claims.userId,
        senderUserId,
        sentAtMs,
      })
    ) {
      sendJson(ws, { type: "error", code: "delete_window", message: "delete window closed" });
      return;
    }
    const deletedAt = new Date().toISOString();
    const deletionType: ChatDeletionType = mode;
    this.ctx.storage.sql.exec(
      `UPDATE messages
       SET body = '',
           mentions_json = '[]',
           mention_all = 0,
           deleted_at = ?,
           deletion_type = ?,
           deleted_by_user_id = ?
       WHERE seq = ?`,
      deletedAt,
      deletionType,
      attach.claims.userId,
      seq
    );
    const event: MessageDeletedEvent = {
      type: "message_deleted",
      seq,
      deletionType,
      deletedAt,
      senderUserId,
      sender: String(row.sender),
      senderRole: senderRoleFromClaims(String(row.sender_role || "caddy")),
      sentAt: String(row.sent_at),
    };
    this.broadcastJson(event);
    void this.notifyDirectoryTombstone(attach.roomId, event);
  }

  private liveAttach(socket: WebSocket): SocketAttach | null {
    const attach = socket.deserializeAttachment() as SocketAttach | ChatTokenClaims | null;
    const now = Math.floor(Date.now() / 1000);
    if (!attach) return this.expire(socket);
    if ("claims" in attach && attach.claims) {
      if (attach.claims.exp <= now) return this.expire(socket);
      return attach;
    }
    const claims = attach as ChatTokenClaims;
    if (claims.exp <= now) return this.expire(socket);
    return { claims, roomId: claims.v === 1 ? claims.room : "" };
  }

  private broadcastVisible(event: ChatMessage) {
    for (const socket of this.ctx.getWebSockets()) {
      const attach = this.liveAttach(socket);
      if (!attach) continue;
      if (event.seq && this.isHiddenFor(attach.claims.userId, event.seq)) continue;
      this.sendSocket(socket, this.redactHiddenReply(event, attach.claims.userId));
    }
  }

  private redactHiddenReply(event: ChatMessage, userId: number): ChatMessage {
    const replySeq = event.replyToSeq;
    if (replySeq == null || !event.replyTo || !this.isHiddenFor(userId, replySeq)) {
      return event;
    }
    return {
      ...event,
      replyTo: {
        seq: replySeq,
        senderUserId: 0,
        sender: "",
        preview: REPLY_DELETED,
        state: "deleted",
      },
    };
  }

  private broadcastJson(event: object) {
    for (const socket of this.ctx.getWebSockets()) {
      const attach = this.liveAttach(socket);
      if (!attach) continue;
      this.sendSocket(socket, event);
    }
  }

  private sendToUser(userId: number, event: object) {
    for (const socket of this.ctx.getWebSockets()) {
      const attach = this.liveAttach(socket);
      if (!attach || attach.claims.userId !== userId) continue;
      this.sendSocket(socket, event);
    }
  }

  private sendSocket(socket: WebSocket, event: object) {
    try {
      if (socket.readyState === WebSocket.OPEN) {
        socket.send(JSON.stringify(event));
      } else {
        socket.close(1011, "dead");
      }
    } catch {
      try {
        socket.close(1011, "send_failed");
      } catch {
        // ignore
      }
    }
  }

  private isHiddenFor(userId: number, seq: number): boolean {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT 1 AS ok FROM hidden_messages WHERE user_id = ? AND seq = ?`,
        userId,
        seq
      )
      .toArray();
    return rows.length > 0;
  }

  private latestVisiblePreview(): {
    seq: number;
    preview: string;
    senderUserId: number;
    senderName: string;
    senderRole: string;
    sentAt: string;
  } | null {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT seq, sender_user_id, sender, sender_role, body, sent_at, deletion_type
         FROM messages
         ORDER BY seq DESC
         LIMIT 1`
      )
      .toArray()[0];
    if (!row) return null;
    const deletionType = parseDeletionType(row.deletion_type);
    return {
      seq: Number(row.seq),
      preview: directorySafePreview({
        body: String(row.body || ""),
        deletionType,
      }),
      senderUserId: Number(row.sender_user_id || 0),
      senderName: String(row.sender || ""),
      senderRole: String(row.sender_role || "caddy"),
      sentAt: String(row.sent_at),
    };
  }

  async alarm() {
    let delay = RETENTION_ALARM_MS;
    try {
      this.purgeExpiredMessages(RETENTION_BATCH);
      const remaining = this.ctx.storage.sql
        .exec(
          `SELECT 1 AS ok FROM messages WHERE sent_at < ? LIMIT 1`,
          new Date(Date.now() - MESSAGE_RETENTION_MS).toISOString()
        )
        .toArray();
      if (remaining.length > 0) delay = 5 * 60 * 1000;
    } catch {
      delay = 5 * 60 * 1000;
    } finally {
      try {
        await this.ctx.storage.setAlarm(Date.now() + delay);
      } catch {
        // alarm optional on local
      }
    }
  }

  private async ensureRetentionAlarm() {
    try {
      const existing = await this.ctx.storage.getAlarm();
      if (existing == null) {
        await this.ctx.storage.setAlarm(Date.now() + RETENTION_ALARM_MS);
      }
    } catch {
      // alarm optional on local
    }
  }

  private purgeExpiredMessages(limit: number) {
    const cutoff = new Date(Date.now() - MESSAGE_RETENTION_MS).toISOString();
    const old = this.ctx.storage.sql
      .exec(
        `SELECT seq FROM messages WHERE sent_at < ? ORDER BY seq ASC LIMIT ?`,
        cutoff,
        limit
      )
      .toArray();
    for (const row of old) {
      const seq = Number(row.seq);
      this.ctx.storage.sql.exec(`DELETE FROM hidden_messages WHERE seq = ?`, seq);
      this.ctx.storage.sql.exec(`DELETE FROM messages WHERE seq = ? AND sent_at < ?`, seq, cutoff);
    }
  }

  private async notifyDirectoryTombstone(roomId: string, event: MessageDeletedEvent) {
    const latest = this.latestVisiblePreview();
    if (!latest) {
      await this.notifyDirectoryPreview(roomId, {
        seq: event.seq,
        preview: DIRECTORY_TOMBSTONE_PREVIEW,
        senderUserId: event.senderUserId,
        senderName: event.sender,
        senderRole: event.senderRole,
        sentAt: event.sentAt,
      });
      return;
    }
    await this.notifyDirectoryPreview(roomId, latest);
  }

  private async notifyDirectoryMessage(roomId: string, message: ChatMessage) {
    await this.notifyDirectoryPreview(roomId, {
      seq: message.seq || 0,
      preview: directorySafePreview({
        body: message.body,
        deletionType: message.deletionType,
      }),
      senderUserId: message.senderUserId,
      senderName: message.sender,
      senderRole: message.senderRole,
      sentAt: message.sentAt,
    });
  }

  private async notifyDirectoryPreview(
    roomId: string,
    payload: {
      seq: number;
      preview: string;
      senderUserId: number;
      senderName: string;
      senderRole: string;
      sentAt: string;
    }
  ) {
    if (!isAllRoomId(roomId) && !isCustomRoomId(roomId)) return;
    try {
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/internal/message"
      );
      await directoryStub(this.env).fetch(
        new Request("https://chat-directory/internal/message", {
          method: "POST",
          headers,
          body: JSON.stringify({
            roomId,
            seq: payload.seq,
            preview: payload.preview,
            senderUserId: payload.senderUserId,
            senderName: payload.senderName,
            senderRole: payload.senderRole,
            sentAt: payload.sentAt,
          }),
        })
      );
    } catch {
      // room message already committed
    }
  }

  private async notifyDirectoryRead(roomId: string, userId: number, seq: number) {
    if (!isAllRoomId(roomId) && !isCustomRoomId(roomId)) return;
    try {
      const headers = await internalAuthHeaders(
        chatInternalSecret(this.env),
        "/internal/read"
      );
      await directoryStub(this.env).fetch(
        new Request("https://chat-directory/internal/read", {
          method: "POST",
          headers,
          body: JSON.stringify({ roomId, userId, seq }),
        })
      );
    } catch {
      // ignore
    }
  }
}
