/**
 * Safe chat-photo client timing. Marks are durations, named stamps, and byte counts.
 * Never record URLs, tokens, claims, file names, or file contents.
 */

export type ChatPhotoTimingMark = {
  name: string;
  ms: number;
};

export type ChatPhotoTimingBag = {
  marks: ChatPhotoTimingMark[];
  stamps?: Record<string, number>;
  sourceBytes?: number;
  uploadBytes?: number;
  compressionMs?: number;
};

export type ChatPhotoTimingSummary = {
  select_to_put_start_ms: number | null;
  put_ms: number | null;
  finalize_ms: number | null;
  send_tap_to_ws_ms: number | null;
};

export type ChatPhotoDebugSample = {
  sourceBytes: number | null;
  uploadBytes: number | null;
  compressionMs: number | null;
  selectedToUploadStartMs: number | null;
  prepareApiMs: number | null;
  blobPutMs: number | null;
  finalizeMs: number | null;
  sendTapToWsMs: number | null;
  selectedToReadyMs: number | null;
  totalUntilWsMs: number | null;
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
  if (name === "select_to_prepared" || name === "select_to_ready") {
    bag.compressionMs = bag.compressionMs ?? (name === "select_to_prepared" ? ms : 0);
  }
  if (isChatPhotoTimingEnabled() && typeof console !== "undefined" && typeof console.debug === "function") {
    console.debug(`[chat-photo] ${name} ${Math.round(ms)}ms`);
  }
  return ms;
}

export function noteChatPhotoBytes(sourceBytes: number, uploadBytes?: number): void {
  const bag = timingBag();
  if (bag.sourceBytes == null) bag.sourceBytes = sourceBytes;
  if (uploadBytes != null) bag.uploadBytes = uploadBytes;
}

export function noteChatPhotoCompression(ms: number): void {
  timingBag().compressionMs = Math.max(0, ms);
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

export function buildChatPhotoDebugSample(
  bag = globalThis.__CHAT_PHOTO_TIMING__
): ChatPhotoDebugSample {
  const summary = summarizeChatPhotoTiming(bag);
  const stamps = bag?.stamps || {};
  const selected = stamps.photo_selected;
  const ready = stamps.prepare_complete;
  const wsSend = stamps.ws_send;
  return {
    sourceBytes: bag?.sourceBytes ?? null,
    uploadBytes: bag?.uploadBytes ?? null,
    compressionMs:
      bag?.compressionMs != null ? Math.round(bag.compressionMs) : latestChatPhotoMark("select_to_prepared", bag),
    selectedToUploadStartMs: summary.select_to_put_start_ms,
    prepareApiMs: latestChatPhotoMark("prepare_api", bag),
    blobPutMs: summary.put_ms,
    finalizeMs: summary.finalize_ms,
    sendTapToWsMs: summary.send_tap_to_ws_ms,
    selectedToReadyMs:
      selected != null && ready != null ? Math.max(0, Math.round(ready - selected)) : latestChatPhotoMark("select_to_ready", bag),
    totalUntilWsMs:
      selected != null && wsSend != null
        ? Math.max(0, Math.round(wsSend - selected))
        : latestChatPhotoMark("total_send", bag),
  };
}

export function emitChatPhotoTimingSummary(): ChatPhotoTimingSummary {
  const summary = summarizeChatPhotoTiming();
  const debug = buildChatPhotoDebugSample();
  if (typeof console !== "undefined" && typeof console.info === "function") {
    console.info("[chat-photo-timing]", JSON.stringify(debug));
  }
  return summary;
}

export function canShowChatPhotoDebug(input: {
  role?: string | null;
  search?: string | null;
}): boolean {
  if (input.role !== "admin") return false;
  const search = String(input.search || "");
  return /(?:^|[?&])photoDebug=1(?:&|$)/.test(search);
}

export function resetChatPhotoTiming(): void {
  const bag = globalThis.__CHAT_PHOTO_TIMING__;
  if (!bag) {
    globalThis.__CHAT_PHOTO_TIMING__ = { marks: [], stamps: {} };
    return;
  }
  bag.marks = [];
  bag.stamps = {};
  delete bag.sourceBytes;
  delete bag.uploadBytes;
  delete bag.compressionMs;
}
