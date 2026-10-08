/**
 * Safe chat-photo client timing. Marks are durations, named stamps, and byte counts.
 * Never record URLs, tokens, claims, file names, or file contents.
 */

import { parseChatPhotoHotpath, type ChatPhotoHotpathSummary } from "@/lib/chatPhotoHotpath";

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
  prepareHotpath?: ChatPhotoHotpathSummary;
  finalizeHotpath?: ChatPhotoHotpathSummary;
  storageBackend?: "r2" | "blob";
  workerIngressMs?: number;
  r2StoreMs?: number;
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
  storageBackend: "r2" | "blob" | null;
  blobPutMs: number | null;
  r2PutMs: number | null;
  workerUploadMs: number | null;
  finalizeMs: number | null;
  sendTapToWsMs: number | null;
  selectedToReadyMs: number | null;
  totalUntilWsMs: number | null;
  prepareServerMs: number | null;
  finalizeServerMs: number | null;
  prepareServerRegion: string | null;
  finalizeServerRegion: string | null;
  prepareServerCold: boolean | null;
  finalizeServerCold: boolean | null;
  prepareAuthMs: number | null;
  prepareRoomAccessMs: number | null;
  prepareCountMs: number | null;
  prepareCreateMs: number | null;
  prepareSignedPutMs: number | null;
  finalizeAuthMs: number | null;
  finalizeRoomAccessMs: number | null;
  finalizeDbFindMs: number | null;
  finalizeBlobMs: number | null;
  r2InspectMs: number | null;
  workerIngressMs: number | null;
  r2StoreMs: number | null;
  receiptVerifyMs: number | null;
  finalizeInspectSkipped: boolean | null;
  roomAccessFastPath: boolean | null;
  finalizeDbUpdateMs: number | null;
  finalizeSignMs: number | null;
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

export function noteChatPhotoStorageBackend(backend: "r2" | "blob"): void {
  timingBag().storageBackend = backend;
}

export function noteChatPhotoWorkerTiming(input: {
  ingressMs?: number;
  storeMs?: number;
}): void {
  const bag = timingBag();
  if (Number.isFinite(input.ingressMs)) bag.workerIngressMs = Math.max(0, Number(input.ingressMs));
  if (Number.isFinite(input.storeMs)) bag.r2StoreMs = Math.max(0, Number(input.storeMs));
}

export function noteChatPhotoServerHotpath(value: unknown): ChatPhotoHotpathSummary | null {
  const hotpath = parseChatPhotoHotpath(value);
  if (!hotpath) return null;
  const bag = timingBag();
  if (hotpath.route === "prepare") bag.prepareHotpath = hotpath;
  if (hotpath.route === "finalize") bag.finalizeHotpath = hotpath;
  return hotpath;
}

export function chatPhotoDebugApiUrl(path: string, search?: string | null): string {
  const query = search ?? (typeof window !== "undefined" ? window.location.search : "");
  if (!/(?:^|[?&])photoDebug=1(?:&|$)/.test(String(query || ""))) return path;
  return path.includes("?") ? `${path}&photoDebug=1` : `${path}?photoDebug=1`;
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
    storageBackend: bag?.storageBackend ?? null,
    blobPutMs: bag?.storageBackend === "r2" ? null : summary.put_ms,
    r2PutMs: bag?.storageBackend === "r2" ? summary.put_ms : null,
    workerUploadMs: bag?.storageBackend === "r2" ? summary.put_ms : null,
    finalizeMs: summary.finalize_ms,
    sendTapToWsMs: summary.send_tap_to_ws_ms,
    selectedToReadyMs:
      selected != null && ready != null ? Math.max(0, Math.round(ready - selected)) : latestChatPhotoMark("select_to_ready", bag),
    totalUntilWsMs:
      selected != null && wsSend != null
        ? Math.max(0, Math.round(wsSend - selected))
        : latestChatPhotoMark("total_send", bag),
    prepareServerMs: bag?.prepareHotpath?.totalMs ?? null,
    finalizeServerMs: bag?.finalizeHotpath?.totalMs ?? null,
    prepareServerRegion: bag?.prepareHotpath?.region ?? null,
    finalizeServerRegion: bag?.finalizeHotpath?.region ?? null,
    prepareServerCold: bag?.prepareHotpath ? bag.prepareHotpath.cold : null,
    finalizeServerCold: bag?.finalizeHotpath ? bag.finalizeHotpath.cold : null,
    prepareAuthMs: bag?.prepareHotpath?.steps.auth ?? null,
    prepareRoomAccessMs: bag?.prepareHotpath?.steps.roomAccess ?? null,
    prepareCountMs: bag?.prepareHotpath?.steps.count ?? null,
    prepareCreateMs: bag?.prepareHotpath?.steps.create ?? null,
    prepareSignedPutMs: bag?.prepareHotpath?.steps.signedPut ?? null,
    finalizeAuthMs: bag?.finalizeHotpath?.steps.auth ?? null,
    finalizeRoomAccessMs: bag?.finalizeHotpath?.steps.roomAccess ?? null,
    finalizeDbFindMs: bag?.finalizeHotpath?.steps.dbFind ?? null,
    finalizeBlobMs: bag?.finalizeHotpath?.steps.blobInspect ?? null,
    r2InspectMs: bag?.finalizeHotpath?.steps.r2Inspect ?? null,
    workerIngressMs: bag?.workerIngressMs != null ? Math.round(bag.workerIngressMs) : null,
    r2StoreMs: bag?.r2StoreMs != null ? Math.round(bag.r2StoreMs) : null,
    receiptVerifyMs: bag?.finalizeHotpath?.steps.receiptVerify ?? null,
    finalizeInspectSkipped: bag?.finalizeHotpath?.flags?.finalizeInspectSkipped ?? null,
    roomAccessFastPath:
      bag?.prepareHotpath?.flags?.roomAccessFastPath ??
      bag?.finalizeHotpath?.flags?.roomAccessFastPath ??
      null,
    finalizeDbUpdateMs: bag?.finalizeHotpath?.steps.dbUpdate ?? null,
    finalizeSignMs: bag?.finalizeHotpath?.steps.claimSign ?? null,
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
  delete bag.prepareHotpath;
  delete bag.finalizeHotpath;
  delete bag.storageBackend;
  delete bag.workerIngressMs;
  delete bag.r2StoreMs;
}
