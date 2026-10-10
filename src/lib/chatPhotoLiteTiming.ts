/**
 * photoLite=1 only. Copies already-computed adaptive timings and last-run
 * boundary timestamps/deltas. No photoDebug, wrapping, or File reads.
 */

import { chatPhotoNow } from "@/lib/chatPhotoTiming";

export type ChatPhotoLiteStampName =
  | "pendingStartAt"
  | "wrapperEnterAt"
  | "sourceEnterAt"
  | "sourceAfterDebugAt"
  | "sourceAfterCarryAt"
  | "sourceAfterRunSetupAt"
  | "sourceAfterAcceptCheckAt"
  | "sourceAfterFastPathCheckAt"
  | "sourceAfterHeicPlanAt"
  | "sourceBeforeRunAt"
  | "adaptiveEnterAt"
  | "adaptiveExitAt"
  | "sourceExitAt"
  | "wrapperExitAt"
  | "pendingEndAt";

export type ChatPhotoLiteSample = {
  selectToReadyMs: number | null;
  prepareOuterMs: number | null;
  adaptiveTotalMs: number | null;
  pendingToWrapperMs: number | null;
  wrapperToSourceMs: number | null;
  sourcePreRunMs: number | null;
  sourceAfterDebugMs: number | null;
  sourceAfterCarryMs: number | null;
  sourceAfterRunSetupMs: number | null;
  sourceAfterAcceptCheckMs: number | null;
  sourceAfterFastPathCheckMs: number | null;
  sourceAfterHeicPlanMs: number | null;
  sourceBeforeRunMs: number | null;
  sourceCarryPresent: boolean | null;
  sourceMetaPresent: boolean | null;
  sourcePlanPresent: boolean | null;
  sourceUsedFallbackPath: boolean | null;
  runToAdaptiveMs: number | null;
  adaptiveMs: number | null;
  adaptiveToSourceExitMs: number | null;
  sourceToWrapperExitMs: number | null;
  wrapperToPendingEndMs: number | null;
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
  pendingStartAt: number | null;
  wrapperEnterAt: number | null;
  sourceEnterAt: number | null;
  sourceAfterDebugAt: number | null;
  sourceAfterCarryAt: number | null;
  sourceAfterRunSetupAt: number | null;
  sourceAfterAcceptCheckAt: number | null;
  sourceAfterFastPathCheckAt: number | null;
  sourceAfterHeicPlanAt: number | null;
  sourceBeforeRunAt: number | null;
  adaptiveEnterAt: number | null;
  adaptiveExitAt: number | null;
  sourceExitAt: number | null;
  wrapperExitAt: number | null;
  pendingEndAt: number | null;
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

function emptyLiteSample(): ChatPhotoLiteSample {
  return {
    selectToReadyMs: null,
    prepareOuterMs: null,
    adaptiveTotalMs: null,
    pendingToWrapperMs: null,
    wrapperToSourceMs: null,
    sourcePreRunMs: null,
    sourceAfterDebugMs: null,
    sourceAfterCarryMs: null,
    sourceAfterRunSetupMs: null,
    sourceAfterAcceptCheckMs: null,
    sourceAfterFastPathCheckMs: null,
    sourceAfterHeicPlanMs: null,
    sourceBeforeRunMs: null,
    sourceCarryPresent: null,
    sourceMetaPresent: null,
    sourcePlanPresent: null,
    sourceUsedFallbackPath: null,
    runToAdaptiveMs: null,
    adaptiveMs: null,
    adaptiveToSourceExitMs: null,
    sourceToWrapperExitMs: null,
    wrapperToPendingEndMs: null,
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
    pendingStartAt: null,
    wrapperEnterAt: null,
    sourceEnterAt: null,
    sourceAfterDebugAt: null,
    sourceAfterCarryAt: null,
    sourceAfterRunSetupAt: null,
    sourceAfterAcceptCheckAt: null,
    sourceAfterFastPathCheckAt: null,
    sourceAfterHeicPlanAt: null,
    sourceBeforeRunAt: null,
    adaptiveEnterAt: null,
    adaptiveExitAt: null,
    sourceExitAt: null,
    wrapperExitAt: null,
    pendingEndAt: null,
  };
}

function liteBag(): ChatPhotoLiteSample {
  return (globalThis.__CHAT_PHOTO_LITE__ ||= emptyLiteSample());
}

function spanMs(start: number | null, end: number | null): number | null {
  if (start == null || end == null) return null;
  return finiteMs(end - start);
}

function publishLiteSpans(next: ChatPhotoLiteSample): void {
  next.pendingToWrapperMs = spanMs(next.pendingStartAt, next.wrapperEnterAt);
  next.wrapperToSourceMs = spanMs(next.wrapperEnterAt, next.sourceEnterAt);
  next.sourcePreRunMs = spanMs(next.sourceEnterAt, next.sourceBeforeRunAt);
  next.sourceAfterDebugMs = spanMs(next.sourceEnterAt, next.sourceAfterDebugAt);
  next.sourceAfterCarryMs = spanMs(next.sourceAfterDebugAt, next.sourceAfterCarryAt);
  next.sourceAfterRunSetupMs = spanMs(next.sourceAfterCarryAt, next.sourceAfterRunSetupAt);
  next.sourceAfterAcceptCheckMs = spanMs(next.sourceAfterRunSetupAt, next.sourceAfterAcceptCheckAt);
  next.sourceAfterFastPathCheckMs = spanMs(next.sourceAfterAcceptCheckAt, next.sourceAfterFastPathCheckAt);
  next.sourceAfterHeicPlanMs = spanMs(next.sourceAfterFastPathCheckAt, next.sourceAfterHeicPlanAt);
  next.sourceBeforeRunMs = spanMs(next.sourceAfterHeicPlanAt, next.sourceBeforeRunAt);
  next.runToAdaptiveMs = spanMs(next.sourceBeforeRunAt, next.adaptiveEnterAt);
  next.adaptiveMs = spanMs(next.adaptiveEnterAt, next.adaptiveExitAt);
  next.adaptiveToSourceExitMs = spanMs(next.adaptiveExitAt, next.sourceExitAt);
  next.sourceToWrapperExitMs = spanMs(next.sourceExitAt, next.wrapperExitAt);
  next.wrapperToPendingEndMs = spanMs(next.wrapperExitAt, next.pendingEndAt);
}

export function noteChatPhotoLiteStamp(name: ChatPhotoLiteStampName, at?: number): void {
  if (!liteOn) return;
  const ts = typeof at === "number" && Number.isFinite(at) ? at : chatPhotoNow();
  const next = liteBag();
  next[name] = ts;
  publishLiteSpans(next);
}

export function noteChatPhotoLiteFlags(flags: {
  sourceCarryPresent?: boolean;
  sourceMetaPresent?: boolean;
  sourcePlanPresent?: boolean;
  sourceUsedFallbackPath?: boolean;
}): void {
  if (!liteOn) return;
  const next = liteBag();
  if (flags.sourceCarryPresent != null) next.sourceCarryPresent = Boolean(flags.sourceCarryPresent);
  if (flags.sourceMetaPresent != null) next.sourceMetaPresent = Boolean(flags.sourceMetaPresent);
  if (flags.sourcePlanPresent != null) next.sourcePlanPresent = Boolean(flags.sourcePlanPresent);
  if (flags.sourceUsedFallbackPath != null) next.sourceUsedFallbackPath = Boolean(flags.sourceUsedFallbackPath);
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
