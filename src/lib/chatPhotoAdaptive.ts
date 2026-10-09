import {
  COURSE_REPORT_HEIC_CONVERT_MESSAGE,
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
} from "@/lib/courseReportPhotoClient";
import {
  CHAT_PHOTO_ADAPTIVE_LONG_EDGE,
  CHAT_PHOTO_ENCODE_MAX_ATTEMPTS,
  CHAT_PHOTO_JPEG_WEBP_TARGET_MAX_BYTES,
  CHAT_PHOTO_MAX_BYTES,
  CHAT_PHOTO_PASSTHROUGH_MAX_BYTES,
  CHAT_PHOTO_PNG_TARGET_MAX_BYTES,
} from "@/lib/chatPhotoConstants";
import {
  canUseChatPhotoFastPath,
  chatPhotoSourceKind,
  isChatPhotoAcceptableSource,
} from "@/lib/chatPhotoFastPath";
import {
  orientedImageHeaderSize,
  readImageSizeFromHeader,
  readJpegExifOrientation,
} from "@/lib/imageHeaderSize";
import {
  chatPhotoNow,
  chatPhotoTimingRunIdFor,
  noteChatPhotoCompressionBreakdown,
} from "@/lib/chatPhotoTiming";

export type ChatPhotoAdaptiveMime = "image/jpeg" | "image/png" | "image/webp";

export type ChatPhotoAdaptivePlan = {
  passthrough: boolean;
  kind: "passthrough" | "jpeg_webp" | "png_readable" | "heic";
  mime: ChatPhotoAdaptiveMime;
  qualities: number[];
  longEdge: number;
  targetMaxBytes: number;
  acceptMaxBytes: number;
  maxAttempts: number;
  keepAlpha: boolean;
};

export type ChatPhotoAdaptiveResult = {
  blob: Blob;
  sourceBytes: number;
  uploadBytes: number;
  compressionMs: number;
  encoded: boolean;
  attempts: number;
  mimeType: string;
  decodeMs?: number | null;
  drawResizeMs?: number | null;
  encode1Ms?: number | null;
  encode2Ms?: number | null;
  inputWidth?: number | null;
  inputHeight?: number | null;
  outputWidth?: number | null;
  outputHeight?: number | null;
  decodePath?: string | null;
  encodePath?: string | null;
  headerProbeMs?: number | null;
  bitmapCreateMs?: number | null;
  canvasCreateMs?: number | null;
  alphaProbeMs?: number | null;
  postEncodeMs?: number | null;
  hiddenBeforeDecodeMs?: number | null;
};

export type ChatPhotoDecodePath = "bitmap-resize" | "bitmap-full" | "image-element";
export type ChatPhotoEncodePath = "offscreen" | "canvas";

export function chatPhotoBitmapResizeOptions(
  width: number,
  height: number,
  longEdge = CHAT_PHOTO_ADAPTIVE_LONG_EDGE
): { resizeWidth: number; resizeHeight: number } | null {
  const sized = scaleChatPhotoSize(width, height, longEdge);
  if (sized.width === width && sized.height === height) return null;
  if (sized.width < 1 || sized.height < 1) return null;
  return { resizeWidth: sized.width, resizeHeight: sized.height };
}

export function shouldAcceptChatPhotoEncode(
  size: number,
  acceptMaxBytes = CHAT_PHOTO_MAX_BYTES
): boolean {
  return Number.isFinite(size) && size > 0 && size <= acceptMaxBytes;
}

export type ChatPhotoEncodeFn = (input: {
  source: Blob;
  width: number;
  height: number;
  mime: ChatPhotoAdaptiveMime;
  quality: number;
}) => Promise<Blob>;

export function scaleChatPhotoSize(
  width: number,
  height: number,
  longEdge = CHAT_PHOTO_ADAPTIVE_LONG_EDGE
): { width: number; height: number } {
  const srcW = Math.max(1, width || 1);
  const srcH = Math.max(1, height || 1);
  const scale = Math.min(1, longEdge / Math.max(srcW, srcH));
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

export function planChatPhotoAdaptive(
  file: { name?: string; type?: string; size: number },
  opts: { hasAlpha?: boolean; heic?: boolean } = {}
): ChatPhotoAdaptivePlan {
  const kind = chatPhotoSourceKind(file);
  const heic = opts.heic || kind === "heic";
  if (!heic && canUseChatPhotoFastPath(file)) {
    return {
      passthrough: true,
      kind: "passthrough",
      mime: kind === "png" ? "image/png" : kind === "webp" ? "image/webp" : "image/jpeg",
      qualities: [],
      longEdge: CHAT_PHOTO_ADAPTIVE_LONG_EDGE,
      targetMaxBytes: CHAT_PHOTO_PASSTHROUGH_MAX_BYTES,
      acceptMaxBytes: CHAT_PHOTO_MAX_BYTES,
      maxAttempts: 0,
      keepAlpha: kind === "png",
    };
  }
  if (kind === "png") {
    const keepAlpha = opts.hasAlpha !== false;
    return {
      passthrough: false,
      kind: "png_readable",
      mime: "image/webp",
      qualities: [0.92, 0.84].slice(0, CHAT_PHOTO_ENCODE_MAX_ATTEMPTS),
      longEdge: CHAT_PHOTO_ADAPTIVE_LONG_EDGE,
      targetMaxBytes: CHAT_PHOTO_PNG_TARGET_MAX_BYTES,
      acceptMaxBytes: CHAT_PHOTO_MAX_BYTES,
      maxAttempts: CHAT_PHOTO_ENCODE_MAX_ATTEMPTS,
      keepAlpha,
    };
  }
  return {
    passthrough: false,
    kind: heic ? "heic" : "jpeg_webp",
    mime: "image/jpeg",
    qualities: [0.82, 0.7].slice(0, CHAT_PHOTO_ENCODE_MAX_ATTEMPTS),
    longEdge: CHAT_PHOTO_ADAPTIVE_LONG_EDGE,
    targetMaxBytes: CHAT_PHOTO_JPEG_WEBP_TARGET_MAX_BYTES,
    acceptMaxBytes: CHAT_PHOTO_MAX_BYTES,
    maxAttempts: CHAT_PHOTO_ENCODE_MAX_ATTEMPTS,
    keepAlpha: false,
  };
}

export function chatPhotoEncodeBottleneck(
  compressionMs: number | null
): "browser-ok" | "consider-native" {
  return compressionMs != null && compressionMs >= 500 ? "consider-native" : "browser-ok";
}

export function chatPhotoPutBottleneck(
  uploadBytes: number | null,
  putMs: number | null
): "put-ok" | "blob-network" {
  if (
    uploadBytes != null &&
    uploadBytes <= CHAT_PHOTO_JPEG_WEBP_TARGET_MAX_BYTES &&
    putMs != null &&
    putMs >= 2000
  ) {
    return "blob-network";
  }
  return "put-ok";
}

type DrawableSource = {
  width: number;
  height: number;
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
};

function canvasToBlob(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  type: string,
  quality?: number
): Promise<Blob> {
  if ("convertToBlob" in canvas && typeof canvas.convertToBlob === "function") {
    return canvas.convertToBlob({ type, quality });
  }
  return new Promise((resolve, reject) => {
    (canvas as HTMLCanvasElement).toBlob(
      (blob) => {
        if (!blob) reject(new Error("encode_failed"));
        else resolve(blob);
      },
      type,
      quality
    );
  });
}

function loadImage(file: Blob): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve(img);
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error("decode_failed"));
    };
    img.src = url;
  });
}

export function chatPhotoDecodePathFromBitmap(
  bitmap: { width: number; height: number },
  requested: { resizeWidth: number; resizeHeight: number } | null
): ChatPhotoDecodePath {
  if (
    requested &&
    bitmap.width === requested.resizeWidth &&
    bitmap.height === requested.resizeHeight
  ) {
    return "bitmap-resize";
  }
  return "bitmap-full";
}

function bitmapResizeInit(
  resize: { resizeWidth: number; resizeHeight: number } | null
): { resizeWidth: number; resizeHeight: number; resizeQuality: "high" } | null {
  if (!resize) return null;
  return {
    resizeWidth: resize.resizeWidth,
    resizeHeight: resize.resizeHeight,
    resizeQuality: "high",
  };
}

/** Prefer EXIF-aware resize; if that throws, resize with SOF pixels; then full decode. */
export async function createChatPhotoOrientedBitmap(
  file: Blob,
  orientedResize?: { resizeWidth: number; resizeHeight: number } | null,
  rawResize?: { resizeWidth: number; resizeHeight: number } | null
): Promise<ImageBitmap> {
  const oriented = bitmapResizeInit(orientedResize ?? null);
  const raw = bitmapResizeInit(rawResize ?? null);
  try {
    return await createImageBitmap(file, {
      imageOrientation: "from-image",
      ...(oriented || {}),
    });
  } catch {
    if (raw) {
      try {
        return await createImageBitmap(file, raw);
      } catch {
        // fall through to unscaled bitmap
      }
    }
    return await createImageBitmap(file);
  }
}

export async function probeChatPhotoOrientedSize(
  file: Blob
): Promise<{ width: number; height: number; rawWidth: number; rawHeight: number } | null> {
  const prefix = new Uint8Array(await file.slice(0, 512 * 1024).arrayBuffer());
  const header = readImageSizeFromHeader(prefix);
  if (!header) return null;
  const oriented = orientedImageHeaderSize(
    header,
    header.format === "jpeg" ? readJpegExifOrientation(prefix) : 1
  );
  return {
    width: oriented.width,
    height: oriented.height,
    rawWidth: header.width,
    rawHeight: header.height,
  };
}

async function loadDrawable(
  file: Blob,
  now: () => number
): Promise<
  DrawableSource & {
    decodePath: ChatPhotoDecodePath;
    headerProbeMs: number;
    bitmapCreateMs: number;
  }
> {
  let orientedResize: { resizeWidth: number; resizeHeight: number } | null = null;
  let rawResize: { resizeWidth: number; resizeHeight: number } | null = null;
  const probeStarted = now();
  try {
    const probed = await probeChatPhotoOrientedSize(file);
    if (probed) {
      orientedResize = chatPhotoBitmapResizeOptions(probed.width, probed.height);
      rawResize = chatPhotoBitmapResizeOptions(probed.rawWidth, probed.rawHeight);
    }
  } catch {
    orientedResize = null;
    rawResize = null;
  }
  const headerProbeMs = Math.max(0, now() - probeStarted);
  if (typeof createImageBitmap === "function") {
    try {
      const bitmapStarted = now();
      const bitmap = await createChatPhotoOrientedBitmap(file, orientedResize, rawResize);
      const bitmapCreateMs = Math.max(0, now() - bitmapStarted);
      const decodePath = chatPhotoDecodePathFromBitmap(bitmap, orientedResize || rawResize);
      return {
        width: bitmap.width,
        height: bitmap.height,
        decodePath,
        headerProbeMs,
        bitmapCreateMs,
        draw(ctx, width, height) {
          ctx.drawImage(bitmap, 0, 0, width, height);
        },
        close() {
          bitmap.close();
        },
      };
    } catch {
      // HTMLImageElement fallback
    }
  }
  const imageStarted = now();
  const img = await loadImage(file);
  return {
    width: img.width,
    height: img.height,
    decodePath: "image-element",
    headerProbeMs,
    bitmapCreateMs: Math.max(0, now() - imageStarted),
    draw(ctx, width, height) {
      ctx.drawImage(img, 0, 0, width, height);
    },
    close() {},
  };
}

function makeCanvas(width: number, height: number): {
  canvas: HTMLCanvasElement | OffscreenCanvas;
  ctx: CanvasRenderingContext2D;
  encodePath: ChatPhotoEncodePath;
} {
  if (typeof OffscreenCanvas === "function") {
    const canvas = new OffscreenCanvas(width, height);
    const ctx = canvas.getContext("2d");
    if (ctx) return { canvas, ctx: ctx as CanvasRenderingContext2D, encodePath: "offscreen" };
  }
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encode_failed");
  return { canvas, ctx, encodePath: "canvas" };
}

function sampleHasAlpha(ctx: CanvasRenderingContext2D, width: number, height: number): boolean {
  const sampleW = Math.min(width, 64);
  const sampleH = Math.min(height, 64);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

async function encodeCanvas(
  canvas: HTMLCanvasElement | OffscreenCanvas,
  mime: ChatPhotoAdaptiveMime,
  quality: number,
  keepAlpha: boolean
): Promise<Blob> {
  try {
    const blob = await canvasToBlob(canvas, mime, quality);
    if (mime === "image/webp" && blob.type && !blob.type.includes("webp")) {
      if (keepAlpha) return canvasToBlob(canvas, "image/png");
      return canvasToBlob(canvas, "image/jpeg", quality);
    }
    return blob;
  } catch {
    if (keepAlpha) return canvasToBlob(canvas, "image/png");
    return canvasToBlob(canvas, "image/jpeg", quality);
  }
}

function finishAdaptiveResult(result: ChatPhotoAdaptiveResult, file?: Blob): ChatPhotoAdaptiveResult {
  noteChatPhotoCompressionBreakdown({
    runId: chatPhotoTimingRunIdFor(file),
    decodeMs: result.decodeMs ?? null,
    drawResizeMs: result.drawResizeMs ?? null,
    encode1Ms: result.encode1Ms ?? null,
    encode2Ms: result.encode2Ms ?? null,
    totalCompressionMs: result.compressionMs,
    adaptiveTotalMs: result.compressionMs,
    inputWidth: result.inputWidth ?? null,
    inputHeight: result.inputHeight ?? null,
    outputWidth: result.outputWidth ?? null,
    outputHeight: result.outputHeight ?? null,
    attempts: result.attempts,
    encodeMime: result.encoded ? result.mimeType : null,
    decodePath: result.decodePath ?? null,
    encodePath: result.encodePath ?? null,
    headerProbeMs: result.headerProbeMs ?? null,
    bitmapCreateMs: result.bitmapCreateMs ?? null,
    canvasCreateMs: result.canvasCreateMs ?? null,
    alphaProbeMs: result.alphaProbeMs ?? null,
    postEncodeMs: result.postEncodeMs ?? null,
    hiddenBeforeDecodeMs: result.hiddenBeforeDecodeMs ?? null,
  });
  return result;
}

export async function prepareChatAdaptivePhoto(
  file: File,
  opts: {
    encode?: ChatPhotoEncodeFn;
    inspect?: (blob: Blob) => Promise<{ width: number; height: number; hasAlpha?: boolean }>;
    decodeHeic?: (file: File) => Promise<Blob>;
    now?: () => number;
    hasAlpha?: boolean;
  } = {}
): Promise<ChatPhotoAdaptiveResult> {
  const now = opts.now || chatPhotoNow;
  const started = now();
  if (!isChatPhotoAcceptableSource(file)) {
    throw new Error(COURSE_REPORT_HEIC_MESSAGE);
  }
  let source: Blob = file;
  const heic = isHeicLikeFile(file) || chatPhotoSourceKind(file) === "heic";
  if (heic) {
    try {
      source = await (opts.decodeHeic || decodeCourseReportPhotoSource)(file);
    } catch {
      throw new Error(COURSE_REPORT_HEIC_CONVERT_MESSAGE);
    }
  }
  const probe = {
    name: file.name || (heic ? "photo.jpg" : "photo"),
    type: source.type || (heic ? "image/jpeg" : file.type),
    size: source.size,
  };
  if (canUseChatPhotoFastPath(probe)) {
    return finishAdaptiveResult({
      blob: source,
      sourceBytes: file.size,
      uploadBytes: source.size,
      compressionMs: Math.max(0, now() - started),
      encoded: false,
      attempts: 0,
      mimeType: probe.type || "image/jpeg",
    }, file);
  }

  const inspect = opts.inspect ? await opts.inspect(source) : null;
  const plan = planChatPhotoAdaptive(probe, {
    heic,
    hasAlpha: opts.hasAlpha ?? inspect?.hasAlpha,
  });
  const dims = scaleChatPhotoSize(inspect?.width || 1600, inspect?.height || 1200, plan.longEdge);

  if (opts.encode) {
    let blob: Blob | null = null;
    let attempts = 0;
    let encode1Ms: number | null = null;
    let encode2Ms: number | null = null;
    for (const quality of plan.qualities) {
      attempts += 1;
      const encodeStarted = now();
      blob = await opts.encode({
        source,
        width: dims.width,
        height: dims.height,
        mime: plan.mime,
        quality,
      });
      const encodeMs = Math.max(0, now() - encodeStarted);
      if (attempts === 1) encode1Ms = encodeMs;
      else encode2Ms = encodeMs;
      if (shouldAcceptChatPhotoEncode(blob.size, plan.acceptMaxBytes)) break;
      if (attempts >= plan.maxAttempts) break;
    }
    if (!blob || blob.size <= 0) throw new Error(COURSE_REPORT_HEIC_CONVERT_MESSAGE);
    if (blob.size > CHAT_PHOTO_MAX_BYTES) {
      throw new Error("사진은 장당 3MB 이하만 첨부할 수 있습니다.");
    }
    return finishAdaptiveResult({
      blob,
      sourceBytes: file.size,
      uploadBytes: blob.size,
      compressionMs: Math.max(0, now() - started),
      encoded: true,
      attempts,
      mimeType: blob.type || plan.mime,
      encode1Ms,
      encode2Ms,
      inputWidth: inspect?.width ?? null,
      inputHeight: inspect?.height ?? null,
      outputWidth: dims.width,
      outputHeight: dims.height,
    }, file);
  }

  let drawable: DrawableSource & {
    decodePath: ChatPhotoDecodePath;
    headerProbeMs: number;
    bitmapCreateMs: number;
  };
  const hiddenBeforeDecodeMs = Math.max(0, now() - started);
  const decodeStarted = now();
  try {
    drawable = await loadDrawable(source, now);
  } catch {
    throw new Error(heic ? COURSE_REPORT_HEIC_CONVERT_MESSAGE : COURSE_REPORT_HEIC_MESSAGE);
  }
  const decodeMs = Math.max(0, now() - decodeStarted);
  try {
    const sized = scaleChatPhotoSize(drawable.width, drawable.height, plan.longEdge);
    const canvasStarted = now();
    const { canvas, ctx, encodePath } = makeCanvas(sized.width, sized.height);
    const canvasCreateMs = Math.max(0, now() - canvasStarted);
    const drawStarted = now();
    drawable.draw(ctx, sized.width, sized.height);
    const drawResizeMs = Math.max(0, now() - drawStarted);
    const alphaStarted = now();
    const keepAlpha =
      plan.keepAlpha || (chatPhotoSourceKind(probe) === "png" && sampleHasAlpha(ctx, sized.width, sized.height));
    const alphaProbeMs = Math.max(0, now() - alphaStarted);
    let blob: Blob | null = null;
    let attempts = 0;
    let encode1Ms: number | null = null;
    let encode2Ms: number | null = null;
    for (const quality of plan.qualities) {
      attempts += 1;
      const encodeStarted = now();
      blob = await encodeCanvas(canvas, plan.mime, quality, keepAlpha);
      const encodeMs = Math.max(0, now() - encodeStarted);
      if (attempts === 1) encode1Ms = encodeMs;
      else encode2Ms = encodeMs;
      if (shouldAcceptChatPhotoEncode(blob.size, plan.acceptMaxBytes)) break;
      if (attempts >= plan.maxAttempts) break;
    }
    if (!blob || blob.size <= 0) throw new Error(COURSE_REPORT_HEIC_CONVERT_MESSAGE);
    if (blob.size > CHAT_PHOTO_MAX_BYTES) {
      throw new Error("사진은 장당 3MB 이하만 첨부할 수 있습니다.");
    }
    const postStarted = now();
    return finishAdaptiveResult({
      blob,
      sourceBytes: file.size,
      uploadBytes: blob.size,
      compressionMs: Math.max(0, now() - started),
      encoded: true,
      attempts,
      mimeType: blob.type || plan.mime,
      decodeMs,
      drawResizeMs,
      encode1Ms,
      encode2Ms,
      inputWidth: drawable.width,
      inputHeight: drawable.height,
      outputWidth: sized.width,
      outputHeight: sized.height,
      decodePath: drawable.decodePath,
      encodePath,
      headerProbeMs: drawable.headerProbeMs,
      bitmapCreateMs: drawable.bitmapCreateMs,
      canvasCreateMs,
      alphaProbeMs,
      postEncodeMs: Math.max(0, now() - postStarted),
      hiddenBeforeDecodeMs,
    }, file);
  } finally {
    drawable.close();
  }
}

export async function prepareChatAdaptiveBlob(file: File): Promise<Blob> {
  return (await prepareChatAdaptivePhoto(file)).blob;
}
