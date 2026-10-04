import type { ChatDeletionType, ChatReplyTo } from "../../cloudflare/verthill-chat/src/protocol";

export const DELETE_FOR_EVERYONE_WINDOW_MS = 10 * 60 * 1000;
export const MESSAGE_RETENTION_DAYS = 180;
export const SYNC_LIMIT = 100;
export const TOMBSTONE_EVERYONE = "메시지가 삭제되었습니다.";
export const TOMBSTONE_ADMIN = "관리자가 메시지를 삭제했습니다.";
export const REPLY_DELETED = "삭제된 메시지입니다.";
export const REPLY_EXPIRED = "보관기간이 지난 메시지입니다.";

export type ChatLineReply = ChatReplyTo;

export type ChatLineBase = {
  clientMessageId: string;
  senderUserId: number;
  sender: string;
  senderRole: string;
  body: string;
  sentAt: string;
  seq?: number;
  mentions: number[];
  mentionAll: boolean;
  replyToSeq?: number | null;
  replyTo?: ChatLineReply | null;
  deletionType?: ChatDeletionType | null;
  deletedAt?: string | null;
};

export function displayTombstone(deletionType: ChatDeletionType | null | undefined): string {
  if (deletionType === "admin") return TOMBSTONE_ADMIN;
  return TOMBSTONE_EVERYONE;
}

export function canDeleteForEveryoneClient(input: {
  myUserId: number | null | undefined;
  senderUserId: number;
  sentAt: string;
  nowMs?: number;
}): boolean {
  const me = Number(input.myUserId);
  if (!Number.isInteger(me) || me <= 0) return false;
  if (me !== input.senderUserId) return false;
  const sent = new Date(input.sentAt).getTime();
  if (!Number.isFinite(sent)) return false;
  const now = input.nowMs ?? Date.now();
  return now - sent >= 0 && now - sent <= DELETE_FOR_EVERYONE_WINDOW_MS;
}

export function chatActionItems(input: {
  myUserId: number | null | undefined;
  myRole: string | null | undefined;
  senderUserId: number;
  sentAt: string;
  deletionType?: ChatDeletionType | null;
  nowMs?: number;
}): Array<"reply" | "hide" | "delete-everyone" | "delete-admin"> {
  if (input.deletionType) return ["hide"];
  const items: Array<"reply" | "hide" | "delete-everyone" | "delete-admin"> = ["reply", "hide"];
  if (
    canDeleteForEveryoneClient({
      myUserId: input.myUserId,
      senderUserId: input.senderUserId,
      sentAt: input.sentAt,
      nowMs: input.nowMs,
    })
  ) {
    items.push("delete-everyone");
  }
  if (input.myRole === "admin") items.push("delete-admin");
  return items;
}

export function lastKnownSeq(lines: Array<{ seq?: number }>): number {
  let max = 0;
  for (const line of lines) {
    const seq = Number(line.seq);
    if (Number.isInteger(seq) && seq > max) max = seq;
  }
  return max;
}

export function mergeChatLines<T extends { clientMessageId: string; seq?: number }>(
  prev: T[],
  incoming: T[]
): T[] {
  const byId = new Map<string, T>();
  const bySeq = new Map<number, string>();
  const put = (line: T) => {
    const seq = Number(line.seq);
    if (Number.isInteger(seq) && seq > 0) {
      const existingId = bySeq.get(seq);
      if (existingId && existingId !== line.clientMessageId) byId.delete(existingId);
      bySeq.set(seq, line.clientMessageId);
    }
    const prevLine = byId.get(line.clientMessageId);
    byId.set(line.clientMessageId, prevLine ? { ...prevLine, ...line } : line);
  };
  for (const line of prev) put(line);
  for (const line of incoming) put(line);
  return [...byId.values()].sort((a, b) => {
    const as = Number(a.seq) || 0;
    const bs = Number(b.seq) || 0;
    if (as !== bs) return as - bs;
    return a.clientMessageId.localeCompare(b.clientMessageId);
  });
}

export function applyHiddenSeq<T extends { seq?: number }>(lines: T[], seq: number): T[] {
  return lines.filter((line) => Number(line.seq) !== seq);
}

export function applyDeletedLine<T extends ChatLineBase>(
  lines: T[],
  patch: {
    seq: number;
    deletionType: ChatDeletionType;
    deletedAt: string;
  }
): T[] {
  return lines.map((line) =>
    Number(line.seq) === patch.seq
      ? {
          ...line,
          body: "",
          mentions: [],
          mentionAll: false,
          deletionType: patch.deletionType,
          deletedAt: patch.deletedAt,
        }
      : line.replyToSeq === patch.seq && line.replyTo
        ? {
            ...line,
            replyTo: { ...line.replyTo, preview: REPLY_DELETED, state: "deleted" as const },
          }
        : line
  );
}

export function estimateChatStorageBytes(input: {
  msgsPerDay: number;
  days?: number;
  avgBodyBytes?: number;
  hiddenRatio?: number;
}): {
  messageCount: number;
  messageBytes: number;
  hiddenBytes: number;
  replyIndexBytes: number;
  totalBytes: number;
} {
  const days = input.days ?? MESSAGE_RETENTION_DAYS;
  const count = Math.max(0, input.msgsPerDay) * days;
  const body = input.avgBodyBytes ?? 180;
  const row = 200;
  const messageBytes = count * (body + row);
  const hiddenBytes = count * (input.hiddenRatio ?? 0.05) * 40;
  const replyIndexBytes = count * 16;
  return {
    messageCount: count,
    messageBytes,
    hiddenBytes,
    replyIndexBytes,
    totalBytes: messageBytes + hiddenBytes + replyIndexBytes,
  };
}

export function formatStorageRange(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
