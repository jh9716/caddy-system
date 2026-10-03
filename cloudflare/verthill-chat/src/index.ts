import { DurableObject } from "cloudflare:workers";
import {
  HISTORY_LIMIT,
  isValidRoomName,
  validateIncomingMessage,
  type ChatMessage,
} from "./protocol";

export { validateIncomingMessage, isValidRoomName } from "./protocol";

export interface Env {
  CHAT_ROOM: DurableObjectNamespace<ChatRoom>;
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

function sendJson(ws: WebSocket, data: unknown) {
  ws.send(JSON.stringify(data));
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      return json({ ok: true, service: "verthill-chat" });
    }
    if (url.pathname === "/ws") {
      const room = (url.searchParams.get("room") || "").trim();
      if (!isValidRoomName(room)) {
        return json({ error: "invalid_room" }, 400);
      }
      if ((request.headers.get("Upgrade") || "").toLowerCase() !== "websocket") {
        return json({ error: "upgrade_required" }, 426);
      }
      const id = env.CHAT_ROOM.idFromName(room);
      return env.CHAT_ROOM.get(id).fetch(request);
    }
    return json({ error: "not_found" }, 404);
  },
};

export class ChatRoom extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    this.ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        client_message_id TEXT NOT NULL UNIQUE,
        sender TEXT NOT NULL,
        body TEXT NOT NULL,
        sent_at TEXT NOT NULL
      )
    `);
    this.ctx.storage.sql.exec(
      `CREATE INDEX IF NOT EXISTS messages_seq ON messages(seq)`
    );
  }

  async fetch(_request: Request): Promise<Response> {
    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];
    this.ctx.acceptWebSocket(server);
    this.pushHistory(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer) {
    if (typeof message !== "string") {
      sendJson(ws, {
        type: "error",
        code: "invalid_payload",
        message: "text JSON required",
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
        `SELECT seq, sender, body, sent_at FROM messages WHERE client_message_id = ?`,
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

    this.ctx.storage.sql.exec(
      `INSERT INTO messages (client_message_id, sender, body, sent_at)
       VALUES (?, ?, ?, ?)`,
      checked.value.clientMessageId,
      checked.value.sender,
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
      sender: checked.value.sender,
      body: checked.value.body,
      sentAt,
      seq: Number(inserted.seq),
    };
    this.broadcast(outbound);
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

  private pushHistory(ws: WebSocket) {
    const rows = this.ctx.storage.sql
      .exec(
        `SELECT seq, client_message_id, sender, body, sent_at
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
      sender: String(row.sender),
      body: String(row.body),
      sentAt: String(row.sent_at),
      seq: Number(row.seq),
    }));
    sendJson(ws, { type: "history", messages });
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
}
