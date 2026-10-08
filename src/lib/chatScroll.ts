/**
 * Chat room entry scroll. Uses directory RoomSummary unread + lastMessageSeq.
 * No new schema. firstUnreadSeq = lastMessageSeq - unread + 1 (seq-space).
 */

export const CHAT_UNREAD_SPLIT_LABEL = "여기부터 읽지 않은 메시지";
export const CHAT_ENTRY_SEEK_MAX_PAGES = 20;

export type ChatEntryKind = "explicit" | "unread" | "bottom";

export type ChatEntryTarget = {
  kind: ChatEntryKind;
  seq: number | null;
};

export type ChatEntrySnapshot = {
  unread: number;
  lastMessageSeq: number;
  firstUnreadSeq: number | null;
  explicitSeq: number | null;
};

export type ChatEntryPin = {
  kind: "bottom" | "seq";
  seq: number | null;
};

export function parseChatTargetSeq(raw: unknown): number | null {
  const n = Number(raw);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

export function parseChatTargetSeqFromRoomUrl(roomId: string, search: string): number | null {
  const query = new URLSearchParams(search.startsWith("?") ? search : `?${search}`);
  const room = String(query.get("room") || "").trim();
  if (room && room !== roomId) return null;
  if (!room) return null;
  return parseChatTargetSeq(query.get("seq"));
}

export function firstUnreadSeqFromSummary(
  lastMessageSeq: unknown,
  unread: unknown
): number | null {
  const latest = Math.floor(Number(lastMessageSeq));
  const n = Math.floor(Number(unread));
  if (!Number.isFinite(latest) || !Number.isFinite(n) || n <= 0 || latest <= 0) {
    return null;
  }
  return Math.max(1, latest - n + 1);
}

export function snapshotChatEntry(input: {
  unread?: unknown;
  lastMessageSeq?: unknown;
  explicitSeq?: unknown;
}): ChatEntrySnapshot {
  const unread = Math.max(0, Math.floor(Number(input.unread) || 0));
  const lastMessageSeq = Math.max(0, Math.floor(Number(input.lastMessageSeq) || 0));
  return {
    unread,
    lastMessageSeq,
    firstUnreadSeq: firstUnreadSeqFromSummary(lastMessageSeq, unread),
    explicitSeq: parseChatTargetSeq(input.explicitSeq),
  };
}

/** Priority: explicit target > first unread > latest bottom. */
export function resolveChatEntryTarget(snapshot: ChatEntrySnapshot): ChatEntryTarget {
  if (snapshot.explicitSeq != null) {
    return { kind: "explicit", seq: snapshot.explicitSeq };
  }
  if (snapshot.firstUnreadSeq != null) {
    return { kind: "unread", seq: snapshot.firstUnreadSeq };
  }
  return { kind: "bottom", seq: null };
}

export function firstLoadedSeqAtOrAfter(
  lines: ReadonlyArray<{ seq?: number | null }>,
  targetSeq: number
): number | null {
  if (!Number.isInteger(targetSeq) || targetSeq <= 0) return null;
  for (const line of lines) {
    const seq = Number(line.seq);
    if (Number.isInteger(seq) && seq > 0 && seq >= targetSeq) return seq;
  }
  return null;
}

export function shouldRequestOlderForTarget(input: {
  targetSeq: number | null;
  oldestLoadedSeq: number | null;
  hasMore: boolean;
  pages: number;
  maxPages?: number;
}): boolean {
  if (!input.hasMore) return false;
  if (input.pages >= (input.maxPages ?? CHAT_ENTRY_SEEK_MAX_PAGES)) return false;
  if (input.targetSeq == null || input.targetSeq <= 0) return false;
  const oldest = Number(input.oldestLoadedSeq);
  if (!Number.isFinite(oldest) || oldest <= 0) return false;
  return input.targetSeq < oldest;
}

export function shouldAutoLoadOlderOnScroll(input: {
  scrollTop: number;
  nearBottom: boolean;
  seeking: boolean;
  thresholdPx?: number;
}): boolean {
  if (input.seeking) return false;
  if (input.nearBottom) return false;
  return input.scrollTop < (input.thresholdPx ?? 48);
}

export function shouldFollowIncomingMessage(input: { stuckToBottom: boolean }): boolean {
  return input.stuckToBottom === true;
}

export function shouldReapplyPinnedEntryScroll(input: {
  userMoved: boolean;
  pin: ChatEntryPin | null;
}): boolean {
  return !input.userMoved && input.pin != null;
}

export function shouldShowUnreadSplit(input: {
  firstUnreadSeq: number | null;
  lineSeq?: number | null;
  prevSeq?: number | null;
}): boolean {
  const first = Number(input.firstUnreadSeq);
  const seq = Number(input.lineSeq);
  if (!Number.isInteger(first) || first <= 0) return false;
  if (!Number.isInteger(seq) || seq <= 0 || seq < first) return false;
  const prev = Number(input.prevSeq);
  if (Number.isInteger(prev) && prev > 0 && prev >= first) return false;
  return true;
}

export function applyChatEntryScroll(
  el: HTMLElement | null,
  pin: ChatEntryPin
): boolean {
  if (!el) return false;
  if (pin.kind === "bottom" || pin.seq == null) {
    el.scrollTop = el.scrollHeight;
    return true;
  }
  const split = el.querySelector(`[data-chat-unread-split="${pin.seq}"]`);
  const target =
    split instanceof HTMLElement
      ? split
      : el.querySelector(`[data-chat-seq="${pin.seq}"]`);
  if (!(target instanceof HTMLElement)) return false;
  const next =
    target.getBoundingClientRect().top - el.getBoundingClientRect().top + el.scrollTop;
  el.scrollTop = Math.max(0, Math.round(next));
  return true;
}
