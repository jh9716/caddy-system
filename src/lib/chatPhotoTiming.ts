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
  decodeMs?: number;
  drawResizeMs?: number;
  encode1Ms?: number;
  encode2Ms?: number;
  inputWidth?: number;
  inputHeight?: number;
  outputWidth?: number;
  outputHeight?: number;
  encodeAttempts?: number;
  encodeMime?: string;
  decodePath?: string;
  encodePath?: string;
  timingRunId?: string;
  adaptiveTotalMs?: number;
  prepareOuterMs?: number;
  headerProbeMs?: number;
  bitmapCreateMs?: number;
  canvasCreateMs?: number;
  alphaProbeMs?: number;
  postEncodeMs?: number;
  stateCommitMs?: number;
  hiddenBeforeDecodeMs?: number;
  prepareHotpath?: ChatPhotoHotpathSummary;
  finalizeHotpath?: ChatPhotoHotpathSummary;
  storageBackend?: "r2" | "blob";
  workerIngressMs?: number;
  workerHashMs?: number;
  workerTotalMs?: number;
  r2StoreMs?: number;
  xhrStartMs?: number;
  xhrUploadCompleteMs?: number;
  xhrResponseCompleteMs?: number;
  xhrFirstProgressMs?: number;
  clientUploadMs?: number;
  responseWaitMs?: number;
  connectionWaitMs?: number;
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
  decodeMs: number | null;
  drawResizeMs: number | null;
  encode1Ms: number | null;
  encode2Ms: number | null;
  inputWidth: number | null;
  inputHeight: number | null;
  outputWidth: number | null;
  outputHeight: number | null;
  encodeAttempts: number | null;
  encodeMime: string | null;
  decodePath: string | null;
  encodePath: string | null;
  timingRunId: string | null;
  adaptiveTotalMs: number | null;
  prepareOuterMs: number | null;
  headerProbeMs: number | null;
  bitmapCreateMs: number | null;
  canvasCreateMs: number | null;
  alphaProbeMs: number | null;
  postEncodeMs: number | null;
  stateCommitMs: number | null;
  hiddenBeforeDecodeMs: number | null;
  unaccountedAdaptiveMs: number | null;
  unaccountedPrepareMs: number | null;
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
  workerHashMs: number | null;
  workerTotalMs: number | null;
  r2StoreMs: number | null;
  receiptVerifyMs: number | null;
  finalizeInspectSkipped: boolean | null;
  roomAccessFastPath: boolean | null;
  roomAccessFallbackReason: string | null;
  xhrStartMs: number | null;
  xhrUploadCompleteMs: number | null;
  xhrResponseCompleteMs: number | null;
  clientUploadMs: number | null;
  responseWaitMs: number | null;
  /** XHR start → first upload progress. Includes connection/preflight/scheduling, not preflight alone. */
  connectionWaitMs: number | null;
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

export type ChatPhotoPrepareScope = {
  runId: string;
  key: string;
  adaptiveTotalMs?: number;
  prepareOuterMs?: number;
  headerProbeMs?: number;
  bitmapCreateMs?: number;
  canvasCreateMs?: number;
  alphaProbeMs?: number;
  postEncodeMs?: number;
  stateCommitMs?: number;
  hiddenBeforeDecodeMs?: number;
  decodeMs?: number;
  drawResizeMs?: number;
  encode1Ms?: number;
  encode2Ms?: number;
  encodeAttempts?: number;
  encodeMime?: string;
  decodePath?: string;
  encodePath?: string;
};

let prepareTimingSeq = 0;
const prepareTimingRuns = new Map<string, ChatPhotoPrepareScope>();
const prepareTimingByFile = new WeakMap<Blob, string>();

export function startChatPhotoPrepareTiming(key: string, file?: Blob): string {
  const runId = `${++prepareTimingSeq}:${key}`;
  prepareTimingRuns.set(runId, { runId, key });
  if (file) prepareTimingByFile.set(file, runId);
  return runId;
}

export function bindChatPhotoTimingFile(file: Blob, runId: string): void {
  prepareTimingByFile.set(file, runId);
}

export function chatPhotoTimingRunIdFor(file?: Blob | null): string | null {
  if (!file) return null;
  return prepareTimingByFile.get(file) ?? null;
}

export function noteChatPhotoPrepareScope(
  runId: string | null | undefined,
  patch: Partial<Omit<ChatPhotoPrepareScope, "runId" | "key">>
): void {
  if (!runId) return;
  const row = prepareTimingRuns.get(runId);
  if (!row) return;
  Object.assign(row, patch);
}

function finiteMs(value: unknown): number | undefined {
  if (!Number.isFinite(value)) return undefined;
  return Math.max(0, Number(value));
}

function applyPrepareScopeToBag(row: ChatPhotoPrepareScope, bag: ChatPhotoTimingBag): void {
  bag.timingRunId = row.runId;
  if (row.adaptiveTotalMs != null) {
    bag.adaptiveTotalMs = row.adaptiveTotalMs;
    bag.compressionMs = row.adaptiveTotalMs;
  }
  if (row.prepareOuterMs != null) bag.prepareOuterMs = row.prepareOuterMs;
  if (row.headerProbeMs != null) bag.headerProbeMs = row.headerProbeMs;
  if (row.bitmapCreateMs != null) bag.bitmapCreateMs = row.bitmapCreateMs;
  if (row.canvasCreateMs != null) bag.canvasCreateMs = row.canvasCreateMs;
  if (row.alphaProbeMs != null) bag.alphaProbeMs = row.alphaProbeMs;
  if (row.postEncodeMs != null) bag.postEncodeMs = row.postEncodeMs;
  if (row.stateCommitMs != null) bag.stateCommitMs = row.stateCommitMs;
  if (row.hiddenBeforeDecodeMs != null) bag.hiddenBeforeDecodeMs = row.hiddenBeforeDecodeMs;
  if (row.decodeMs != null) bag.decodeMs = row.decodeMs;
  if (row.drawResizeMs != null) bag.drawResizeMs = row.drawResizeMs;
  if (row.encode1Ms != null) bag.encode1Ms = row.encode1Ms;
  if (row.encode2Ms != null) bag.encode2Ms = row.encode2Ms;
  if (row.encodeAttempts != null) bag.encodeAttempts = row.encodeAttempts;
  if (row.encodeMime) bag.encodeMime = row.encodeMime;
  if (row.decodePath) bag.decodePath = row.decodePath;
  if (row.encodePath) bag.encodePath = row.encodePath;
}

export function commitChatPhotoPrepareTiming(runId: string | null | undefined): ChatPhotoPrepareScope | null {
  if (!runId) return null;
  const row = prepareTimingRuns.get(runId);
  if (!row) return null;
  applyPrepareScopeToBag(row, timingBag());
  return row;
}

/** Outer prepare wall time only. Never overwrites adaptive compressionMs. */
export function noteChatPhotoCompression(ms: number): void {
  timingBag().prepareOuterMs = Math.max(0, ms);
}

export function noteChatPhotoCompressionBreakdown(input: {
  runId?: string | null;
  decodeMs?: number | null;
  drawResizeMs?: number | null;
  encode1Ms?: number | null;
  encode2Ms?: number | null;
  totalCompressionMs?: number | null;
  adaptiveTotalMs?: number | null;
  headerProbeMs?: number | null;
  bitmapCreateMs?: number | null;
  canvasCreateMs?: number | null;
  alphaProbeMs?: number | null;
  postEncodeMs?: number | null;
  hiddenBeforeDecodeMs?: number | null;
  inputWidth?: number | null;
  inputHeight?: number | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  attempts?: number | null;
  encodeMime?: string | null;
  decodePath?: string | null;
  encodePath?: string | null;
}): void {
  const adaptiveTotal = finiteMs(input.adaptiveTotalMs ?? input.totalCompressionMs);
  const scoped: Partial<Omit<ChatPhotoPrepareScope, "runId" | "key">> = {};
  const decodeMs = finiteMs(input.decodeMs);
  const drawResizeMs = finiteMs(input.drawResizeMs);
  const encode1Ms = finiteMs(input.encode1Ms);
  const encode2Ms = finiteMs(input.encode2Ms);
  const headerProbeMs = finiteMs(input.headerProbeMs);
  const bitmapCreateMs = finiteMs(input.bitmapCreateMs);
  const canvasCreateMs = finiteMs(input.canvasCreateMs);
  const alphaProbeMs = finiteMs(input.alphaProbeMs);
  const postEncodeMs = finiteMs(input.postEncodeMs);
  const hiddenBeforeDecodeMs = finiteMs(input.hiddenBeforeDecodeMs);
  if (adaptiveTotal != null) scoped.adaptiveTotalMs = adaptiveTotal;
  if (decodeMs != null) scoped.decodeMs = decodeMs;
  if (drawResizeMs != null) scoped.drawResizeMs = drawResizeMs;
  if (encode1Ms != null) scoped.encode1Ms = encode1Ms;
  if (encode2Ms != null) scoped.encode2Ms = encode2Ms;
  if (headerProbeMs != null) scoped.headerProbeMs = headerProbeMs;
  if (bitmapCreateMs != null) scoped.bitmapCreateMs = bitmapCreateMs;
  if (canvasCreateMs != null) scoped.canvasCreateMs = canvasCreateMs;
  if (alphaProbeMs != null) scoped.alphaProbeMs = alphaProbeMs;
  if (postEncodeMs != null) scoped.postEncodeMs = postEncodeMs;
  if (hiddenBeforeDecodeMs != null) scoped.hiddenBeforeDecodeMs = hiddenBeforeDecodeMs;
  if (Number.isFinite(input.attempts)) scoped.encodeAttempts = Math.max(0, Math.round(Number(input.attempts)));
  if (typeof input.encodeMime === "string" && input.encodeMime) {
    const mime = input.encodeMime.toLowerCase().split(";", 1)[0] || "";
    if (mime === "image/jpeg" || mime === "image/png" || mime === "image/webp") scoped.encodeMime = mime;
  }
  if (
    input.decodePath === "bitmap-resize" ||
    input.decodePath === "bitmap-full" ||
    input.decodePath === "image-element"
  ) {
    scoped.decodePath = input.decodePath;
  }
  if (input.encodePath === "offscreen" || input.encodePath === "canvas") {
    scoped.encodePath = input.encodePath;
  }

  if (input.runId && prepareTimingRuns.has(input.runId)) {
    noteChatPhotoPrepareScope(input.runId, scoped);
  }

  const bag = timingBag();
  if (adaptiveTotal != null) {
    bag.adaptiveTotalMs = adaptiveTotal;
    bag.compressionMs = adaptiveTotal;
  }
  if (decodeMs != null) bag.decodeMs = decodeMs;
  if (drawResizeMs != null) bag.drawResizeMs = drawResizeMs;
  if (encode1Ms != null) bag.encode1Ms = encode1Ms;
  if (encode2Ms != null) bag.encode2Ms = encode2Ms;
  if (headerProbeMs != null) bag.headerProbeMs = headerProbeMs;
  if (bitmapCreateMs != null) bag.bitmapCreateMs = bitmapCreateMs;
  if (canvasCreateMs != null) bag.canvasCreateMs = canvasCreateMs;
  if (alphaProbeMs != null) bag.alphaProbeMs = alphaProbeMs;
  if (postEncodeMs != null) bag.postEncodeMs = postEncodeMs;
  if (hiddenBeforeDecodeMs != null) bag.hiddenBeforeDecodeMs = hiddenBeforeDecodeMs;
  if (Number.isFinite(input.inputWidth)) bag.inputWidth = Math.max(0, Math.round(Number(input.inputWidth)));
  if (Number.isFinite(input.inputHeight)) bag.inputHeight = Math.max(0, Math.round(Number(input.inputHeight)));
  if (Number.isFinite(input.outputWidth)) bag.outputWidth = Math.max(0, Math.round(Number(input.outputWidth)));
  if (Number.isFinite(input.outputHeight)) bag.outputHeight = Math.max(0, Math.round(Number(input.outputHeight)));
  if (scoped.encodeAttempts != null) bag.encodeAttempts = scoped.encodeAttempts;
  if (scoped.encodeMime) bag.encodeMime = scoped.encodeMime;
  if (scoped.decodePath) bag.decodePath = scoped.decodePath;
  if (scoped.encodePath) bag.encodePath = scoped.encodePath;
}

export function noteChatPhotoStorageBackend(backend: "r2" | "blob"): void {
  timingBag().storageBackend = backend;
}

export function noteChatPhotoWorkerTiming(input: {
  ingressMs?: number;
  hashMs?: number;
  storeMs?: number;
  workerTotalMs?: number;
}): void {
  const bag = timingBag();
  if (Number.isFinite(input.ingressMs)) bag.workerIngressMs = Math.max(0, Number(input.ingressMs));
  if (Number.isFinite(input.hashMs)) bag.workerHashMs = Math.max(0, Number(input.hashMs));
  if (Number.isFinite(input.storeMs)) bag.r2StoreMs = Math.max(0, Number(input.storeMs));
  if (Number.isFinite(input.workerTotalMs)) bag.workerTotalMs = Math.max(0, Number(input.workerTotalMs));
}

export function noteChatPhotoPutSplit(input: {
  xhrStartMs?: number;
  xhrUploadCompleteMs?: number;
  xhrResponseCompleteMs?: number;
  xhrFirstProgressMs?: number;
  clientUploadMs?: number;
  responseWaitMs?: number;
  connectionWaitMs?: number;
}): void {
  const bag = timingBag();
  if (Number.isFinite(input.xhrStartMs)) bag.xhrStartMs = Number(input.xhrStartMs);
  if (Number.isFinite(input.xhrUploadCompleteMs)) bag.xhrUploadCompleteMs = Number(input.xhrUploadCompleteMs);
  if (Number.isFinite(input.xhrResponseCompleteMs)) bag.xhrResponseCompleteMs = Number(input.xhrResponseCompleteMs);
  if (Number.isFinite(input.xhrFirstProgressMs)) bag.xhrFirstProgressMs = Number(input.xhrFirstProgressMs);
  if (Number.isFinite(input.clientUploadMs)) bag.clientUploadMs = Math.max(0, Number(input.clientUploadMs));
  if (Number.isFinite(input.responseWaitMs)) bag.responseWaitMs = Math.max(0, Number(input.responseWaitMs));
  if (Number.isFinite(input.connectionWaitMs)) bag.connectionWaitMs = Math.max(0, Number(input.connectionWaitMs));
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

function unaccountedAdaptiveMs(bag?: ChatPhotoTimingBag): number | null {
  const total = bag?.adaptiveTotalMs ?? bag?.compressionMs;
  if (total == null) return null;
  const parts = [bag?.hiddenBeforeDecodeMs, bag?.decodeMs, bag?.canvasCreateMs, bag?.drawResizeMs, bag?.alphaProbeMs, bag?.encode1Ms, bag?.encode2Ms, bag?.postEncodeMs];
  if (parts.every((part) => part == null)) return null;
  const accounted = parts.reduce((sum, part) => sum + (part ?? 0), 0);
  return Math.max(0, Math.round(total - accounted));
}

function unaccountedPrepareMs(bag?: ChatPhotoTimingBag): number | null {
  if (bag?.prepareOuterMs == null || bag?.adaptiveTotalMs == null) return null;
  return Math.max(0, Math.round(bag.prepareOuterMs - bag.adaptiveTotalMs));
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
      bag?.compressionMs != null
        ? Math.round(bag.compressionMs)
        : bag?.adaptiveTotalMs != null
          ? Math.round(bag.adaptiveTotalMs)
          : null,
    decodeMs: bag?.decodeMs != null ? Math.round(bag.decodeMs) : null,
    drawResizeMs: bag?.drawResizeMs != null ? Math.round(bag.drawResizeMs) : null,
    encode1Ms: bag?.encode1Ms != null ? Math.round(bag.encode1Ms) : null,
    encode2Ms: bag?.encode2Ms != null ? Math.round(bag.encode2Ms) : null,
    inputWidth: bag?.inputWidth ?? null,
    inputHeight: bag?.inputHeight ?? null,
    outputWidth: bag?.outputWidth ?? null,
    outputHeight: bag?.outputHeight ?? null,
    encodeAttempts: bag?.encodeAttempts ?? null,
    encodeMime: bag?.encodeMime ?? null,
    decodePath: bag?.decodePath ?? null,
    encodePath: bag?.encodePath ?? null,
    timingRunId: bag?.timingRunId ?? null,
    adaptiveTotalMs: bag?.adaptiveTotalMs != null ? Math.round(bag.adaptiveTotalMs) : null,
    prepareOuterMs: bag?.prepareOuterMs != null ? Math.round(bag.prepareOuterMs) : null,
    headerProbeMs: bag?.headerProbeMs != null ? Math.round(bag.headerProbeMs) : null,
    bitmapCreateMs: bag?.bitmapCreateMs != null ? Math.round(bag.bitmapCreateMs) : null,
    canvasCreateMs: bag?.canvasCreateMs != null ? Math.round(bag.canvasCreateMs) : null,
    alphaProbeMs: bag?.alphaProbeMs != null ? Math.round(bag.alphaProbeMs) : null,
    postEncodeMs: bag?.postEncodeMs != null ? Math.round(bag.postEncodeMs) : null,
    stateCommitMs: bag?.stateCommitMs != null ? Math.round(bag.stateCommitMs) : null,
    hiddenBeforeDecodeMs: bag?.hiddenBeforeDecodeMs != null ? Math.round(bag.hiddenBeforeDecodeMs) : null,
    unaccountedAdaptiveMs: unaccountedAdaptiveMs(bag),
    unaccountedPrepareMs: unaccountedPrepareMs(bag),
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
    workerHashMs: bag?.workerHashMs != null ? Math.round(bag.workerHashMs) : null,
    workerTotalMs: bag?.workerTotalMs != null ? Math.round(bag.workerTotalMs) : null,
    r2StoreMs: bag?.r2StoreMs != null ? Math.round(bag.r2StoreMs) : null,
    receiptVerifyMs: bag?.finalizeHotpath?.steps.receiptVerify ?? null,
    finalizeInspectSkipped: bag?.finalizeHotpath?.flags?.finalizeInspectSkipped ?? null,
    roomAccessFastPath:
      bag?.prepareHotpath?.flags?.roomAccessFastPath ??
      bag?.finalizeHotpath?.flags?.roomAccessFastPath ??
      null,
    roomAccessFallbackReason:
      bag?.prepareHotpath?.reasons?.roomAccessFallbackReason ??
      bag?.finalizeHotpath?.reasons?.roomAccessFallbackReason ??
      null,
    xhrStartMs: bag?.xhrStartMs != null ? Math.round(bag.xhrStartMs) : null,
    xhrUploadCompleteMs: bag?.xhrUploadCompleteMs != null ? Math.round(bag.xhrUploadCompleteMs) : null,
    xhrResponseCompleteMs: bag?.xhrResponseCompleteMs != null ? Math.round(bag.xhrResponseCompleteMs) : null,
    clientUploadMs: bag?.clientUploadMs != null ? Math.round(bag.clientUploadMs) : null,
    responseWaitMs: bag?.responseWaitMs != null ? Math.round(bag.responseWaitMs) : null,
    connectionWaitMs: bag?.connectionWaitMs != null ? Math.round(bag.connectionWaitMs) : null,
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
  prepareTimingRuns.clear();
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
  delete bag.decodeMs;
  delete bag.drawResizeMs;
  delete bag.encode1Ms;
  delete bag.encode2Ms;
  delete bag.inputWidth;
  delete bag.inputHeight;
  delete bag.outputWidth;
  delete bag.outputHeight;
  delete bag.encodeAttempts;
  delete bag.encodeMime;
  delete bag.decodePath;
  delete bag.encodePath;
  delete bag.timingRunId;
  delete bag.adaptiveTotalMs;
  delete bag.prepareOuterMs;
  delete bag.headerProbeMs;
  delete bag.bitmapCreateMs;
  delete bag.canvasCreateMs;
  delete bag.alphaProbeMs;
  delete bag.postEncodeMs;
  delete bag.stateCommitMs;
  delete bag.hiddenBeforeDecodeMs;
  prepareTimingRuns.clear();
  delete bag.prepareHotpath;
  delete bag.finalizeHotpath;
  delete bag.storageBackend;
  delete bag.workerIngressMs;
  delete bag.workerHashMs;
  delete bag.workerTotalMs;
  delete bag.r2StoreMs;
  delete bag.xhrStartMs;
  delete bag.xhrUploadCompleteMs;
  delete bag.xhrResponseCompleteMs;
  delete bag.xhrFirstProgressMs;
  delete bag.clientUploadMs;
  delete bag.responseWaitMs;
  delete bag.connectionWaitMs;
}
