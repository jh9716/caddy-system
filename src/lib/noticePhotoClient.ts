import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import {
  NOTICE_MEDIA_UPLOAD_CONCURRENCY,
  mapNoticeBoundedSettled,
  resolveNoticeUploadOptions,
  type NoticeUploadOptions,
  type NoticeUploadProgress,
} from "@/lib/noticeMediaUpload";
import {
  COURSE_REPORT_HEIC_CONVERT_MESSAGE,
  COURSE_REPORT_HEIC_MESSAGE,
  COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE,
  courseReportPhotoBlobFingerprint,
  courseReportPhotoFileId,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
} from "@/lib/courseReportPhotoClient";
import {
  NOTICE_PHOTO_JPEG_QUALITY,
  NOTICE_PHOTO_MAX_BYTES,
  noticePhotoSizeMessage,
} from "@/lib/noticePhotoConstants";
import {
  isNoticeKeepPngMime,
  noticePhotoCanPassthrough,
  noticePhotoTargetSize,
} from "@/lib/noticePhotoPrepare";

export {
  NOTICE_MEDIA_UPLOAD_CONCURRENCY,
  mapNoticeBoundedSettled,
  type NoticeUploadOptions,
  type NoticeUploadProgress,
} from "@/lib/noticeMediaUpload";

export type NoticePendingPhotoStatus = "preparing" | "ready" | "failed";

export type NoticePendingPick = {
  key: string;
  file: File;
  blob: Blob | null;
  previewUrl: string;
  fileId: string;
  fingerprint: string;
  status: NoticePendingPhotoStatus;
  error?: string;
};

export function revokeNoticePreviewUrl(url: string | undefined | null) {
  if (!url || !url.startsWith("blob:") || typeof URL.revokeObjectURL !== "function") return;
  URL.revokeObjectURL(url);
}

export function instantNoticePhotoPicks(
  files: File[],
  room: number,
  already: { fileIds?: Iterable<string> } = {}
): { items: NoticePendingPick[]; note: string } {
  const seenIds = new Set(already.fileIds ?? []);
  const items: NoticePendingPick[] = [];
  let note = "";
  for (const file of files) {
    if (items.length >= Math.max(0, room)) break;
    const fileId = courseReportPhotoFileId(file);
    if (seenIds.has(fileId)) {
      note = COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE;
      continue;
    }
    seenIds.add(fileId);
    const previewUrl = isHeicLikeFile(file) ? "" : URL.createObjectURL(file);
    items.push({
      key: `${Date.now()}-${items.length}-${fileId}`,
      file,
      blob: null,
      previewUrl,
      fileId,
      fingerprint: "",
      status: "preparing",
    });
  }
  return { items, note };
}

export async function prepareNoticePendingPhoto(
  item: NoticePendingPick
): Promise<NoticePendingPick> {
  try {
    const blob = await prepareNoticePhoto(item.file);
    const fingerprint = await courseReportPhotoBlobFingerprint(blob);
    let previewUrl = item.previewUrl;
    if (!previewUrl) {
      previewUrl = URL.createObjectURL(blob);
    }
    return {
      ...item,
      blob,
      fingerprint,
      previewUrl,
      status: "ready",
      error: undefined,
    };
  } catch (e) {
    return {
      ...item,
      status: "failed",
      error: e instanceof Error ? e.message : COURSE_REPORT_HEIC_CONVERT_MESSAGE,
    };
  }
}

export async function uploadNoticePendingPhotos(
  noticeId: number,
  items: { blob: Blob | null }[],
  postOrOpts?: typeof fetch | NoticeUploadOptions,
  onProgressArg?: (progress: NoticeUploadProgress) => void
): Promise<{ uploaded: number; failed: number; failedIndexes: number[] }> {
  const { post, onProgress, sortOrderStart } = resolveNoticeUploadOptions(
    postOrOpts,
    onProgressArg
  );
  const failedIndexes: number[] = [];
  let uploaded = 0;
  let failed = 0;
  let unauthorized = false;
  let done = 0;
  const total = items.length;
  onProgress?.({ done, total });

  await mapNoticeBoundedSettled(items, NOTICE_MEDIA_UPLOAD_CONCURRENCY, async (item, i) => {
    try {
      if (unauthorized) {
        failed += 1;
        failedIndexes.push(i);
        done += 1;
        onProgress?.({ done, total });
        return;
      }
      const blob = item.blob;
      if (!blob || blob.size <= 0) {
        failed += 1;
        failedIndexes.push(i);
        done += 1;
        onProgress?.({ done, total });
        return;
      }
      const mime = (blob.type || "image/jpeg").toLowerCase();
      const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
      const fd = new FormData();
      fd.append("file", blob, `photo-${i}.${ext}`);
      if (sortOrderStart != null) {
        fd.append("sortOrder", String(sortOrderStart + i));
      }
      const res = await post(`/api/notice/${noticeId}/photos`, {
        method: "POST",
        credentials: "include",
        body: fd,
      });
      if (consumeUnauthorizedMemberResponse(res)) {
        unauthorized = true;
        failed += 1;
        failedIndexes.push(i);
        done += 1;
        onProgress?.({ done, total });
        return;
      }
      if (res.ok) uploaded += 1;
      else {
        failed += 1;
        failedIndexes.push(i);
      }
      done += 1;
      onProgress?.({ done, total });
    } catch {
      failed += 1;
      failedIndexes.push(i);
      done += 1;
      onProgress?.({ done, total });
    }
  });

  failedIndexes.sort((a, b) => a - b);
  return { uploaded, failed, failedIndexes };
}

function canvasToBlob(
  canvas: HTMLCanvasElement,
  type: string,
  quality?: number
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
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

type DrawableSource = {
  width: number;
  height: number;
  draw(ctx: CanvasRenderingContext2D, width: number, height: number): void;
  close(): void;
};

async function loadDrawable(file: Blob): Promise<DrawableSource> {
  if (typeof createImageBitmap === "function") {
    try {
      const bitmap = await createImageBitmap(file);
      return {
        width: bitmap.width,
        height: bitmap.height,
        draw(ctx, width, height) {
          ctx.drawImage(bitmap, 0, 0, width, height);
        },
        close() {
          bitmap.close();
        },
      };
    } catch {
      // fall through to HTMLImageElement
    }
  }
  const img = await loadImage(file);
  return {
    width: img.width,
    height: img.height,
    draw(ctx, width, height) {
      ctx.drawImage(img, 0, 0, width, height);
    },
    close() {},
  };
}

async function encodeNoticeCanvas(
  drawable: DrawableSource,
  width: number,
  height: number,
  mime: string
): Promise<Blob> {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encode_failed");
  drawable.draw(ctx, width, height);
  if (isNoticeKeepPngMime(mime)) {
    return canvasToBlob(canvas, "image/png");
  }
  if (mime === "image/webp") {
    const webp = await canvasToBlob(canvas, "image/webp", NOTICE_PHOTO_JPEG_QUALITY);
    if (webp.type === "image/webp" && webp.size > 0) return webp;
  }
  return canvasToBlob(canvas, "image/jpeg", NOTICE_PHOTO_JPEG_QUALITY);
}

/** Notice-only preprocess. Does not change course-report or chat encode settings. */
export async function prepareNoticePhoto(file: File): Promise<Blob> {
  if (file.size > NOTICE_PHOTO_MAX_BYTES * 4) {
    throw new Error("사진이 너무 큽니다.");
  }
  const source = await decodeCourseReportPhotoSource(file);
  let drawable: DrawableSource;
  try {
    drawable = await loadDrawable(source);
  } catch {
    throw new Error(
      isHeicLikeFile(file) ? COURSE_REPORT_HEIC_CONVERT_MESSAGE : COURSE_REPORT_HEIC_MESSAGE
    );
  }
  try {
    const mime = (source.type || file.type || "").toLowerCase();
    if (
      noticePhotoCanPassthrough({
        width: drawable.width,
        height: drawable.height,
        size: source.size,
        mime,
      })
    ) {
      return source;
    }
    let width = noticePhotoTargetSize(drawable.width, drawable.height).width;
    let height = noticePhotoTargetSize(drawable.width, drawable.height).height;
    for (let attempt = 0; attempt < 4; attempt++) {
      const blob = await encodeNoticeCanvas(drawable, width, height, mime);
      if (blob.size <= NOTICE_PHOTO_MAX_BYTES) return blob;
      width = Math.max(1, Math.round(width * 0.85));
      height = Math.max(1, Math.round(height * 0.85));
    }
    throw new Error(noticePhotoSizeMessage());
  } finally {
    drawable.close();
  }
}

/** Kept for tests: prepare then return. The form uses instantNoticePhotoPicks instead. */
export async function pickNoticePhotos(
  files: File[],
  room: number,
  already: {
    fileIds?: Iterable<string>;
    fingerprints?: Iterable<string>;
  } = {}
) {
  const started = instantNoticePhotoPicks(files, room, already);
  const seenPrints = new Set(already.fingerprints ?? []);
  const items: NoticePendingPick[] = [];
  let note = started.note;
  for (const item of started.items) {
    const prepared = await prepareNoticePendingPhoto(item);
    if (prepared.status !== "ready" || !prepared.blob) {
      revokeNoticePreviewUrl(prepared.previewUrl);
      note = prepared.error || COURSE_REPORT_HEIC_CONVERT_MESSAGE;
      continue;
    }
    if (prepared.fingerprint && seenPrints.has(prepared.fingerprint)) {
      revokeNoticePreviewUrl(prepared.previewUrl);
      note = COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE;
      continue;
    }
    if (prepared.fingerprint) seenPrints.add(prepared.fingerprint);
    items.push(prepared);
  }
  return { items, note };
}
