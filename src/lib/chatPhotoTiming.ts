/**
 * Safe chat-photo client timing. Marks are durations and named stamps only.
 * Never record URLs, tokens, claims, or file contents.
 */

export type ChatPhotoTimingMark = {
  name: string;
  ms: number;
};

export type ChatPhotoTimingBag = {
  marks: ChatPhotoTimingMark[];
  stamps?: Record<string, number>;
};

export type ChatPhotoTimingSummary = {
  select_to_put_start_ms: number | null;
  put_ms: number | null;
  finalize_ms: number | null;
  send_tap_to_ws_ms: number | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __CHAT_PHOTO_TIMING__: ChatPhotoTimingBag | undefined;
}

export function chatPhotoNow(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

export function isChatPhotoTimingEnabled(): boolean {
  if (typeof globalThis !== "undefined" && globalThis.__CHAT_PHOTO_TIMING__) return true;
  return typeof process !== "undefined" && process.env.NODE_ENV !== "production";
}

function timingBag(): ChatPhotoTimingBag {
  const bag = (globalThis.__CHAT_PHOTO_TIMING__ ||= { marks: [], stamps: {} });
  bag.stamps ||= {};
  return bag;
}

export function stampChatPhotoTiming(name: string, at = chatPhotoNow()): number {
  const bag = timingBag();
  if (bag.stamps![name] == null) bag.stamps![name] = at;
  return at;
}

export function markChatPhotoTiming(name: string, startedAt: number): number {
  const ms = Math.max(0, chatPhotoNow() - startedAt);
  const bag = timingBag();
  bag.marks.push({ name, ms });
  if (isChatPhotoTimingEnabled() && typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(`[chat-photo] ${name} ${Math.round(ms)}ms`);
  }
  return ms;
}

export function latestChatPhotoMark(name: string, bag = globalThis.__CHAT_PHOTO_TIMING__): number | null {
  if (!bag?.marks?.length) return null;
  for (let i = bag.marks.length - 1; i >= 0; i--) {
    if (bag.marks[i]?.name === name) return bag.marks[i]!.ms;
  }
  return null;
}

export function summarizeChatPhotoTiming(
  bag = globalThis.__CHAT_PHOTO_TIMING__
): ChatPhotoTimingSummary {
  const stamps = bag?.stamps || {};
  const selected = stamps.photo_selected;
  const putStart = stamps.put_start;
  const sendTap = stamps.send_tap;
  const wsSend = stamps.ws_send;
  return {
    select_to_put_start_ms:
      selected != null && putStart != null ? Math.max(0, Math.round(putStart - selected)) : null,
    put_ms: latestChatPhotoMark("direct_put", bag),
    finalize_ms: latestChatPhotoMark("finalize_api", bag),
    send_tap_to_ws_ms:
      sendTap != null && wsSend != null ? Math.max(0, Math.round(wsSend - sendTap)) : null,
  };
}

export function emitChatPhotoTimingSummary(): ChatPhotoTimingSummary {
  const summary = summarizeChatPhotoTiming();
  if (typeof console !== "undefined" && typeof console.info === "function") {
    console.info("[chat-photo-timing]", JSON.stringify(summary));
  }
  return summary;
}

export function resetChatPhotoTiming(): void {
  const bag = globalThis.__CHAT_PHOTO_TIMING__;
  if (!bag) {
    globalThis.__CHAT_PHOTO_TIMING__ = { marks: [], stamps: {} };
    return;
  }
  bag.marks = [];
  bag.stamps = {};
}
