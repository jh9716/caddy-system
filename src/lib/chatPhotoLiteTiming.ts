/**
 * photoLite=1 only. Copies already-computed adaptive timings.
 * Does not enable photoDebug, Proxy, prepare-scope maps, or File reads.
 */

export type ChatPhotoLiteSample = {
  selectToReadyMs: number | null;
  prepareOuterMs: number | null;
  adaptiveTotalMs: number | null;
  hiddenBeforeDecodeMs: number | null;
  headerProbeMs: number | null;
  bitmapCreateMs: number | null;
  decodeMs: number | null;
  canvasCreateMs: number | null;
  drawResizeMs: number | null;
  alphaProbeMs: number | null;
  encode1Ms: number | null;
  encode2Ms: number | null;
  postEncodeMs: number | null;
  decodePath: string | null;
  encodePath: string | null;
  outputWidth: number | null;
  outputHeight: number | null;
  uploadBytes: number | null;
};

declare global {
  // eslint-disable-next-line no-var
  var __CHAT_PHOTO_LITE__: ChatPhotoLiteSample | undefined;
}

let liteOn = false;

function finiteMs(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value)) return null;
  return Math.max(0, Math.round(value));
}

export function canShowChatPhotoLite(search?: string | null): boolean {
  return /(?:^|[?&])photoLite=1(?:&|$)/.test(String(search || ""));
}

export function isChatPhotoLiteTiming(): boolean {
  return liteOn;
}

export function enableChatPhotoLiteTiming(on: boolean): void {
  liteOn = Boolean(on);
  if (!liteOn && typeof globalThis !== "undefined") delete globalThis.__CHAT_PHOTO_LITE__;
}

export function readChatPhotoLiteSample(): ChatPhotoLiteSample | null {
  return typeof globalThis !== "undefined" ? globalThis.__CHAT_PHOTO_LITE__ ?? null : null;
}

export function resetChatPhotoLiteSample(): void {
  if (typeof globalThis !== "undefined") delete globalThis.__CHAT_PHOTO_LITE__;
}

function liteBag(): ChatPhotoLiteSample {
  return (globalThis.__CHAT_PHOTO_LITE__ ||= {
    selectToReadyMs: null,
    prepareOuterMs: null,
    adaptiveTotalMs: null,
    hiddenBeforeDecodeMs: null,
    headerProbeMs: null,
    bitmapCreateMs: null,
    decodeMs: null,
    canvasCreateMs: null,
    drawResizeMs: null,
    alphaProbeMs: null,
    encode1Ms: null,
    encode2Ms: null,
    postEncodeMs: null,
    decodePath: null,
    encodePath: null,
    outputWidth: null,
    outputHeight: null,
    uploadBytes: null,
  });
}

export function noteChatPhotoLiteAdaptive(result: {
  compressionMs?: number | null;
  hiddenBeforeDecodeMs?: number | null;
  headerProbeMs?: number | null;
  bitmapCreateMs?: number | null;
  decodeMs?: number | null;
  canvasCreateMs?: number | null;
  drawResizeMs?: number | null;
  alphaProbeMs?: number | null;
  encode1Ms?: number | null;
  encode2Ms?: number | null;
  postEncodeMs?: number | null;
  decodePath?: string | null;
  encodePath?: string | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  uploadBytes?: number | null;
}): void {
  if (!liteOn) return;
  const next = liteBag();
  next.adaptiveTotalMs = finiteMs(result.compressionMs);
  next.hiddenBeforeDecodeMs = finiteMs(result.hiddenBeforeDecodeMs);
  next.headerProbeMs = finiteMs(result.headerProbeMs);
  next.bitmapCreateMs = finiteMs(result.bitmapCreateMs);
  next.decodeMs = finiteMs(result.decodeMs);
  next.canvasCreateMs = finiteMs(result.canvasCreateMs);
  next.drawResizeMs = finiteMs(result.drawResizeMs);
  next.alphaProbeMs = finiteMs(result.alphaProbeMs);
  next.encode1Ms = finiteMs(result.encode1Ms);
  next.encode2Ms = finiteMs(result.encode2Ms);
  next.postEncodeMs = finiteMs(result.postEncodeMs);
  next.decodePath = typeof result.decodePath === "string" && result.decodePath ? result.decodePath : null;
  next.encodePath = typeof result.encodePath === "string" && result.encodePath ? result.encodePath : null;
  next.outputWidth = finiteMs(result.outputWidth);
  next.outputHeight = finiteMs(result.outputHeight);
  next.uploadBytes = finiteMs(result.uploadBytes);
}

export function noteChatPhotoLiteReady(input: {
  selectToReadyMs?: number | null;
  prepareOuterMs?: number | null;
  uploadBytes?: number | null;
}): void {
  if (!liteOn) return;
  const next = liteBag();
  const selectToReadyMs = finiteMs(input.selectToReadyMs);
  const prepareOuterMs = finiteMs(input.prepareOuterMs);
  const uploadBytes = finiteMs(input.uploadBytes);
  if (selectToReadyMs != null) next.selectToReadyMs = selectToReadyMs;
  if (prepareOuterMs != null) next.prepareOuterMs = prepareOuterMs;
  if (uploadBytes != null) next.uploadBytes = uploadBytes;
}
