import { DurableObject } from "cloudflare:workers";
import { verifyInternalRequest } from "./internalAuth";
import {
  ALL_ROOM_ID,
  ALL_ROOM_NAME,
  MAX_DIRECTORY_CONNECTIONS,
  chatNotificationTag,
  clampReadSeq,
  computeUnread,
  isAllRoomId,
  isCustomRoomId,
  truncatePreview,
  type ChatSenderRole,
  type RoomSummary,
} from "./protocol";
import { isChatTokenV2, type ChatTokenClaims } from "./token";

export type DirectoryEnv = {
  CHAT_AUTH_SECRET: string;
  CHAT_INTERNAL_SECRET?: string;
};

type MemberSnap = {
  userId: number;
  displayName: string;
  role: string;
  team: string;
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sendJson(ws: WebSocket, data: unknown) {
  ws.send(JSON.stringify(data));
}

export class ChatDirectory extends DurableObject<DirectoryEnv> {
  constructor(ctx: DurableObjectState, env: DirectoryEnv) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS rooms (
        room_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        owner_user_id INTEGER,
        created_at TEXT NOT NULL,
        last_message_seq INTEGER NOT NULL DEFAULT 0,
        last_message_preview TEXT,
        last_message_at TEXT,
        last_sender_name TEXT,
        last_sender_user_id INTEGER,
        last_sender_role TEXT,
        member_count INTEGER NOT NULL DEFAULT 0
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (
        room_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        display_name TEXT NOT NULL DEFAULT '',
        role TEXT NOT NULL DEFAULT 'caddy',
        team TEXT NOT NULL DEFAULT '-',
        joined_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id)
      )
    `);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS read_state (
        room_id TEXT NOT NULL,
        user_id INTEGER NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (room_id, user_id)
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS members_user ON members(user_id)`
    );
    this.ensureAllRoom();
  }

  private ensureAllRoom() {
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT OR IGNORE INTO rooms
        (room_id, name, type, owner_user_id, created_at, member_count)
       VALUES (?, ?, 'ALL', NULL, ?, 0)`,
      ALL_ROOM_ID,
      ALL_ROOM_NAME,
      now
    );
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/internal/")) {
      if (!(await verifyInternalRequest(request, this.env, url.pathname))) {
        return json({ error: "forbidden" }, 403);
      }
      if (request.method === "POST" && url.pathname === "/internal/message") {
        return this.handleInternalMessage(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/read") {
        return this.handleInternalRead(request);
      }
      if (request.method === "POST" && url.pathname === "/internal/create") {
        return this.handleInternalCreate(request);
      }
      if (request.method === "GET" && url.pathname === "/internal/member") {
        const roomId = url.searchParams.get("room") || "";
        const userId = Number(url.searchParams.get("userId"));
        return json({ ok: true, member: this.isMember(roomId, userId) });
      }
      return json({ error: "not_found" }, 404);
    }

    let claims: ChatTokenClaims | null = null;
    try {
      const raw = request.headers.get("x-chat-claims") || "";
      claims = raw ? (JSON.parse(raw) as ChatTokenClaims) : null;
    } catch {
      claims = null;
    }
    if (!claims || !isChatTokenV2(claims)) {
      return json({ error: "invalid_token" }, 401);
    }

    if (url.pathname === "/directory/ws") {
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      if (this.ctx.getWebSockets().length >= MAX_DIRECTORY_CONNECTIONS) {
        return json({ error: "directory_full" }, 503);
      }
      const pair = new WebSocketPair();
      const client = pair[0];
      const server = pair[1];
      this.ctx.acceptWebSocket(server);
      server.serializeAttachment(claims);
      sendJson(server, { type: "rooms", rooms: this.listForUser(claims.userId) });
      return new Response(null, { status: 101, webSocket: client });
    }

    if (request.method === "GET" && url.pathname === "/directory/rooms") {
      return json({ ok: true, rooms: this.listForUser(claims.userId) });
    }

    const membersMatch = /^\/directory\/rooms\/([^/]+)\/members$/.exec(url.pathname);
    if (request.method === "GET" && membersMatch) {
      const roomId = decodeURIComponent(membersMatch[1] || "");
      if (isAllRoomId(roomId) || this.isMember(roomId, claims.userId)) {
        return json({ ok: true, members: this.listMembers(roomId) });
      }
      return json({ error: "room_forbidden" }, 403);
    }

    return json({ error: "not_found" }, 404);
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    const claims = ws.deserializeAttachment() as ChatTokenClaims | null;
    if (!claims || claims.exp <= Math.floor(Date.now() / 1000)) {
      try {
        ws.close(4008, "expired_token");
      } catch {
        // ignore
      }
      return;
    }
    if (typeof message !== "string") return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(message);
    } catch {
      return;
    }
    if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "sync") {
      sendJson(ws, { type: "rooms", rooms: this.listForUser(claims.userId) });
    }
  }

  webSocketClose(ws: WebSocket) {
    try {
      ws.close(1000, "closed");
    } catch {
      // already closed
    }
  }

  isMember(roomId: string, userId: number): boolean {
    if (isAllRoomId(roomId)) return true;
    const rows = this.ctx.storage.sql
      .exec(`SELECT 1 AS ok FROM members WHERE room_id = ? AND user_id = ?`, roomId, userId)
      .toArray();
    return rows.length > 0;
  }

  private listMembers(roomId: string) {
    if (isAllRoomId(roomId)) {
      return [];
    }
    return this.ctx.storage.sql
      .exec(
        `SELECT user_id, display_name, role, team, joined_at
         FROM members WHERE room_id = ? ORDER BY joined_at ASC`,
        roomId
      )
      .toArray()
      .map((row) => ({
        userId: Number(row.user_id),
        displayName: String(row.display_name || ""),
        role: String(row.role || "caddy"),
        team: String(row.team || "-"),
        joinedAt: String(row.joined_at),
      }));
  }

  private lastRead(roomId: string, userId: number): number {
    const row = this.ctx.storage.sql
      .exec(
        `SELECT last_read_seq FROM read_state WHERE room_id = ? AND user_id = ?`,
        roomId,
        userId
      )
      .toArray()[0];
    return row ? Number(row.last_read_seq || 0) : 0;
  }

  private listForUser(userId: number): RoomSummary[] {
    const rooms = this.ctx.storage.sql
      .exec(
        `SELECT r.*
         FROM rooms r
         WHERE r.type = 'ALL'
            OR EXISTS (
              SELECT 1 FROM members m
              WHERE m.room_id = r.room_id AND m.user_id = ?
            )
         ORDER BY CASE WHEN r.type = 'ALL' THEN 0 ELSE 1 END,
                  IFNULL(r.last_message_at, r.created_at) DESC`
      , userId)
      .toArray();
    return rooms.map((row) => this.toSummary(row, userId));
  }

  private toSummary(row: Record<string, unknown>, userId: number): RoomSummary {
    const roomId = String(row.room_id);
    const latest = Number(row.last_message_seq || 0);
    return {
      roomId,
      name: String(row.name),
      type: String(row.type) === "ALL" ? "ALL" : "CUSTOM",
      ownerUserId: row.owner_user_id == null ? null : Number(row.owner_user_id),
      memberCount: Number(row.member_count || 0),
      lastMessageSeq: latest,
      lastMessagePreview: String(row.last_message_preview || ""),
      lastMessageAt: row.last_message_at ? String(row.last_message_at) : null,
      lastSenderName: row.last_sender_name ? String(row.last_sender_name) : null,
      lastSenderRole: row.last_sender_role
        ? (String(row.last_sender_role) as ChatSenderRole)
        : null,
      unread: computeUnread(latest, this.lastRead(roomId, userId)),
      createdAt: String(row.created_at),
      notificationTag: chatNotificationTag(roomId),
    };
  }

  private async handleInternalCreate(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      roomId: string;
      name: string;
      ownerUserId: number;
      members: MemberSnap[];
    };
    if (!isCustomRoomId(body.roomId)) {
      return json({ error: "invalid_room" }, 400);
    }
    const existing = this.ctx.storage.sql
      .exec(`SELECT owner_user_id FROM rooms WHERE room_id = ?`, body.roomId)
      .toArray();
    if (existing.length) {
      const owner = Number(existing[0]?.owner_user_id || 0);
      if (owner === body.ownerUserId) {
        return json({ ok: true, roomId: body.roomId, idempotent: true });
      }
      return json({ error: "room_exists" }, 409);
    }
    const now = new Date().toISOString();
    this.ctx.storage.sql.exec(
      `INSERT INTO rooms (room_id, name, type, owner_user_id, created_at, member_count)
       VALUES (?, ?, 'CUSTOM', ?, ?, ?)`,
      body.roomId,
      body.name,
      body.ownerUserId,
      now,
      body.members.length
    );
    for (const member of body.members) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO members
          (room_id, user_id, display_name, role, team, joined_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        body.roomId,
        member.userId,
        member.displayName,
        member.role,
        member.team,
        now
      );
    }
    this.broadcastRooms(body.members.map((m) => m.userId));
    return json({ ok: true, roomId: body.roomId });
  }

  private async handleInternalMessage(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      roomId: string;
      seq: number;
      preview: string;
      senderUserId: number;
      senderName: string;
      senderRole: string;
      sentAt: string;
    };
    if (!isAllRoomId(body.roomId) && !isCustomRoomId(body.roomId)) {
      return json({ ok: true, ignored: "legacy" });
    }
    this.ensureAllRoom();
    if (isAllRoomId(body.roomId)) {
      this.ctx.storage.sql.exec(
        `INSERT OR IGNORE INTO rooms
          (room_id, name, type, owner_user_id, created_at, member_count)
         VALUES (?, ?, 'ALL', NULL, ?, 0)`,
        ALL_ROOM_ID,
        ALL_ROOM_NAME,
        body.sentAt
      );
    }
    this.ctx.storage.sql.exec(
      `UPDATE rooms
       SET last_message_seq = ?,
           last_message_preview = ?,
           last_message_at = ?,
           last_sender_name = ?,
           last_sender_user_id = ?,
           last_sender_role = ?
       WHERE room_id = ?`,
      body.seq,
      truncatePreview(body.preview),
      body.sentAt,
      body.senderName,
      body.senderUserId,
      body.senderRole,
      body.roomId
    );
    this.upsertRead(body.roomId, body.senderUserId, body.seq, body.sentAt);
    this.broadcastAffected(body.roomId);
    return json({ ok: true });
  }

  private async handleInternalRead(request: Request): Promise<Response> {
    const body = (await request.json()) as {
      roomId: string;
      userId: number;
      seq: number;
    };
    this.upsertRead(body.roomId, body.userId, body.seq, new Date().toISOString());
    this.broadcastToUser(body.userId);
    return json({ ok: true });
  }

  private latestSeq(roomId: string): number {
    const row = this.ctx.storage.sql
      .exec(`SELECT last_message_seq FROM rooms WHERE room_id = ?`, roomId)
      .toArray()[0];
    return row ? Number(row.last_message_seq || 0) : 0;
  }

  private upsertRead(roomId: string, userId: number, seq: number, at: string) {
    const current = this.lastRead(roomId, userId);
    const next = Math.max(current, clampReadSeq(seq, this.latestSeq(roomId)));
    this.ctx.storage.sql.exec(
      `INSERT INTO read_state (room_id, user_id, last_read_seq, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(room_id, user_id)
       DO UPDATE SET last_read_seq = excluded.last_read_seq, updated_at = excluded.updated_at`,
      roomId,
      userId,
      next,
      at
    );
  }

  private liveDirectoryClaims(ws: WebSocket): ChatTokenClaims | null {
    const claims = ws.deserializeAttachment() as ChatTokenClaims | null;
    if (!claims || claims.exp <= Math.floor(Date.now() / 1000)) {
      try {
        ws.close(4008, "expired_token");
      } catch {
        // ignore
      }
      return null;
    }
    return claims;
  }

  private broadcastAffected(roomId: string) {
    for (const ws of this.ctx.getWebSockets()) {
      const claims = this.liveDirectoryClaims(ws);
      if (!claims) continue;
      if (!isAllRoomId(roomId) && !this.isMember(roomId, claims.userId)) continue;
      try {
        sendJson(ws, { type: "rooms", rooms: this.listForUser(claims.userId) });
      } catch {
        // ignore
      }
    }
  }

  private broadcastRooms(userIds: number[]) {
    const allow = new Set(userIds);
    for (const ws of this.ctx.getWebSockets()) {
      const claims = this.liveDirectoryClaims(ws);
      if (!claims || !allow.has(claims.userId)) continue;
      try {
        sendJson(ws, { type: "rooms", rooms: this.listForUser(claims.userId) });
      } catch {
        // ignore
      }
    }
  }

  private broadcastToUser(userId: number) {
    for (const ws of this.ctx.getWebSockets()) {
      const claims = this.liveDirectoryClaims(ws);
      if (!claims || claims.userId !== userId) continue;
      try {
        sendJson(ws, { type: "rooms", rooms: this.listForUser(userId) });
      } catch {
        // ignore
      }
    }
  }
}
