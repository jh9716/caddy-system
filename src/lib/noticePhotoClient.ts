import { consumeUnauthorizedMemberResponse } from "@/lib/memberSessionRedirect";
import {
  COURSE_REPORT_HEIC_CONVERT_MESSAGE,
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
  pickCourseReportPhotos,
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

export async function uploadNoticePendingPhotos(
  noticeId: number,
  items: { blob: Blob }[],
  post: typeof fetch = fetch
): Promise<{ uploaded: number; failed: number; failedIndexes: number[] }> {
  let uploaded = 0;
  let failed = 0;
  const failedIndexes: number[] = [];
  for (let i = 0; i < items.length; i++) {
    const blob = items[i].blob;
    const mime = (blob.type || "image/jpeg").toLowerCase();
    const ext = mime.includes("png") ? "png" : mime.includes("webp") ? "webp" : "jpg";
    const fd = new FormData();
    fd.append("file", blob, `photo-${i}.${ext}`);
    const res = await post(`/api/notice/${noticeId}/photos`, {
      method: "POST",
      credentials: "include",
      body: fd,
    });
    if (consumeUnauthorizedMemberResponse(res)) {
      for (let j = i; j < items.length; j++) failedIndexes.push(j);
      return { uploaded, failed: failed + (items.length - i), failedIndexes };
    }
    if (res.ok) uploaded += 1;
    else {
      failed += 1;
      failedIndexes.push(i);
    }
  }
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

export async function pickNoticePhotos(
  files: File[],
  room: number,
  already: {
    fileIds?: Iterable<string>;
    fingerprints?: Iterable<string>;
  } = {}
) {
  return pickCourseReportPhotos(files, room, prepareNoticePhoto, already);
}
