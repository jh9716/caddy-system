import {
  NOTICE_PHOTO_LONG_EDGE,
  NOTICE_PHOTO_MAX_BYTES,
  NOTICE_PHOTO_MAX_SHORT_EDGE,
  NOTICE_PHOTO_MIMES,
  NOTICE_PHOTO_TALL_ASPECT,
  type NoticePhotoMime,
} from "@/lib/noticePhotoConstants";

export function isNoticeTallCapture(width: number, height: number): boolean {
  const w = Math.max(1, width);
  const h = Math.max(1, height);
  const ratio = Math.max(w, h) / Math.min(w, h);
  return ratio >= NOTICE_PHOTO_TALL_ASPECT;
}

export function noticePhotoTargetSize(
  width: number,
  height: number
): { width: number; height: number } {
  const srcW = Math.max(1, Math.round(width));
  const srcH = Math.max(1, Math.round(height));
  if (isNoticeTallCapture(srcW, srcH)) {
    const short = Math.min(srcW, srcH);
    const scale = Math.min(1, NOTICE_PHOTO_MAX_SHORT_EDGE / short);
    return {
      width: Math.max(1, Math.round(srcW * scale)),
      height: Math.max(1, Math.round(srcH * scale)),
    };
  }
  const longEdge = Math.max(srcW, srcH);
  const scale = Math.min(1, NOTICE_PHOTO_LONG_EDGE / longEdge);
  return {
    width: Math.max(1, Math.round(srcW * scale)),
    height: Math.max(1, Math.round(srcH * scale)),
  };
}

export function isNoticeKeepPngMime(mime: string): boolean {
  return mime.toLowerCase() === "image/png";
}

export function noticePhotoCanPassthrough(input: {
  width: number;
  height: number;
  size: number;
  mime: string;
}): boolean {
  const mime = input.mime.toLowerCase() as NoticePhotoMime | string;
  if (!(NOTICE_PHOTO_MIMES as readonly string[]).includes(mime)) return false;
  if (!Number.isFinite(input.size) || input.size <= 0) return false;
  if (input.size > NOTICE_PHOTO_MAX_BYTES) return false;
  const target = noticePhotoTargetSize(input.width, input.height);
  return target.width === input.width && target.height === input.height;
}
