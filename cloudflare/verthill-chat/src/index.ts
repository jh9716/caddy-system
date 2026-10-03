import { DurableObject } from "cloudflare:workers";
import { ChatDirectory } from "./directory";
import {
  DIRECTORY_NAME,
    HISTORY_LIMIT,
    MAX_CONNECTIONS,
    MAX_CONNECTIONS_ALL,
    MESSAGE_MAX,
  isAllRoomId,
  isCustomRoomId,
  isLegacyTeamRoomId,
  isValidRoomName,
  senderRoleFromClaims,
  truncatePreview,
  validateIncomingMessage,
  validateIncomingRead,
  type ChatMessage,
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

async function isDirectoryMember(
  env: Env,
  roomId: string,
  userId: number
): Promise<boolean> {
  const res = await directoryStub(env).fetch(
    `https://chat-directory/internal/member?room=${encodeURIComponent(roomId)}&userId=${userId}`
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

async function forwardDirectory(
  request: Request,
  env: Env,
  pathname: string
): Promise<Response> {
  const identity = await verifyIdentity(request, env);
  if (identity instanceof Response) return identity;
  const headers = new Headers(request.headers);
  headers.set("x-chat-claims", JSON.stringify(identity));
  const url = new URL(request.url);
  url.pathname = pathname;
  return directoryStub(env).fetch(
    new Request(url.toString(), {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
    })
  );
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
      return forwardDirectory(request, env, "/directory/ws");
    }
    if (request.method === "GET" && url.pathname === "/directory/rooms") {
      return forwardDirectory(request, env, "/directory/rooms");
    }
    const membersMatch = /^\/directory\/rooms\/([^/]+)\/members$/.exec(url.pathname);
    if (request.method === "GET" && membersMatch) {
      return forwardDirectory(request, env, url.pathname);
    }
    if (request.method === "POST" && url.pathname === "/directory/rooms") {
      return createRoomFromGrant(request, env);
    }
    return json({ error: "not_found" }, 404);
  },
};

async function createRoomFromGrant(request: Request, env: Env): Promise<Response> {
  const secret = String(env.CHAT_AUTH_SECRET || "").trim();
  if (!secret) return json({ error: "chat_auth_unconfigured" }, 503);
  let body: { grant?: string };
  try {
    body = (await request.json()) as { grant?: string };
  } catch {
    return json({ error: "invalid_payload" }, 400);
  }
  const grant = await verifyCreateGrant(String(body.grant || ""), secret);
  if (!grant) return json({ error: "invalid_grant" }, 401);
  return directoryStub(env).fetch(
    new Request("https://chat-directory/internal/create", {
      method: "POST",
      headers: { "content-type": "application/json" },
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
        sent_at TEXT NOT NULL
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
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq)`
    );
  }

  async fetch(request: Request): Promise<Response> {
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
    this.pushHistory(server);
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
    if (parsed && typeof parsed === "object" && (parsed as { type?: string }).type === "read") {
      const read = validateIncomingRead(parsed);
      if (!read.ok) {
        sendJson(ws, { type: "error", code: read.code, message: read.message });
        return;
      }
      void this.notifyDirectoryRead(attach.roomId, attach.claims.userId, read.seq);
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

    const sentAt = new Date().toISOString();
    const existing = this.ctx.storage.sql
      .exec(
        `SELECT seq FROM messages WHERE client_message_id = ?`,
        checked.value.clientMessageId
      )
      .toArray();
    if (existing.length > 0) {
      sendJson(ws, {
        type: "duplicate",
        clientMessageId: checked.value.clientMessageId,
      });
      return;
    }

    const senderRole = senderRoleFromClaims(attach.claims.role);
    this.ctx.storage.sql.exec(
      `INSERT INTO messages (client_message_id, sender_user_id, sender, sender_role, body, sent_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
      checked.value.clientMessageId,
      attach.claims.userId,
      attach.claims.displayName,
      senderRole,
      checked.value.body,
      sentAt
    );
    this.trimHistory();
    const inserted = this.ctx.storage.sql
      .exec(
        `SELECT seq FROM messages WHERE client_message_id = ?`,
        checked.value.clientMessageId
      )
      .one();
    const outbound: ChatMessage = {
      type: "message",
      clientMessageId: checked.value.clientMessageId,
      senderUserId: attach.claims.userId,
      sender: attach.claims.displayName,
      senderRole,
      body: checked.value.body,
      sentAt,
      seq: Number(inserted.seq),
    };
    this.broadcast(outbound);
    void this.notifyDirectoryMessage(attach.roomId, outbound);
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

  private pushHistory(ws: WebSocket) {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT seq, client_message_id, sender_user_id, sender, sender_role, body, sent_at
         FROM messages
         ORDER BY seq DESC
         LIMIT ?`,
        HISTORY_LIMIT
      )
      .toArray()
      .reverse();
    const messages: ChatMessage[] = rows.map((row) => ({
      type: "message",
      clientMessageId: String(row.client_message_id),
      senderUserId: Number(row.sender_user_id || 0),
      sender: String(row.sender),
      senderRole: senderRoleFromClaims(String(row.sender_role || "caddy")),
      body: String(row.body),
      sentAt: String(row.sent_at),
      seq: Number(row.seq),
    }));
    const oldestSeq = messages.length ? Number(messages[0]!.seq) : null;
    sendJson(ws, {
      type: "history",
      messages,
      hasMore: false,
      oldestSeq,
    });
  }

  private trimHistory() {
    this.ctx.storage.sql.exec(
      `DELETE FROM messages
       WHERE seq < IFNULL((SELECT MAX(seq) FROM messages), 0) - ?`,
      HISTORY_LIMIT - 1
    );
  }

  private broadcast(event: ChatMessage) {
    const payload = JSON.stringify(event);
    for (const socket of this.ctx.getWebSockets()) {
      try {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(payload);
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
  }

  private async notifyDirectoryMessage(roomId: string, message: ChatMessage) {
    if (!isAllRoomId(roomId) && !isCustomRoomId(roomId)) return;
    try {
      await directoryStub(this.env).fetch(
        new Request("https://chat-directory/internal/message", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            roomId,
            seq: message.seq,
            preview: truncatePreview(message.body),
            senderUserId: message.senderUserId,
            senderName: message.sender,
            senderRole: message.senderRole,
            sentAt: message.sentAt,
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
      await directoryStub(this.env).fetch(
        new Request("https://chat-directory/internal/read", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ roomId, userId, seq }),
        })
      );
    } catch {
      // ignore
    }
  }
}
