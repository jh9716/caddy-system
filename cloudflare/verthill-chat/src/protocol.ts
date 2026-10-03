export const BODY_MAX = 2000;
export const SENDER_MAX = 64;
export const CLIENT_ID_MAX = 128;
export const HISTORY_LIMIT = 30;
export const MAX_CONNECTIONS = 200;
export const MESSAGE_MAX = 4096;
export const ROOM_NAME_RE = /^team-([1-9]|1[0-2])$/;
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

export type ChatMessage = {
  type: "message";
  clientMessageId: string;
  senderUserId: number;
  sender: string;
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

export function isValidRoomName(room: string): boolean {
  return ROOM_NAME_RE.test(room) && (ALLOWED_ROOMS as readonly string[]).includes(room);
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
