import {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_JPEG_QUALITY,
  COURSE_REPORT_PHOTO_LONG_EDGE,
  COURSE_REPORT_PHOTO_MAX,
  COURSE_REPORT_PHOTO_MAX_BYTES,
} from "@/lib/courseReportPhotoConstants";

export const COURSE_REPORT_HEIC_MESSAGE = "JPG/PNG/WEBP 형식으로 첨부해 주세요.";
export const COURSE_REPORT_HEIC_CONVERT_MESSAGE =
  "이 사진을 변환할 수 없습니다. JPG로 다시 선택해 주세요.";

export function isHeicLikeFile(file: File): boolean {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return (
    type.includes("heic") ||
    type.includes("heif") ||
    name.endsWith(".heic") ||
    name.endsWith(".heif")
  );
}

type HeicConverter = (file: Blob) => Promise<Blob>;
let heicConverterForTests: HeicConverter | null = null;

export function setHeicConverterForTests(fn: HeicConverter | null) {
  heicConverterForTests = fn;
}

async function convertHeicToJpegBlob(file: Blob): Promise<Blob> {
  if (heicConverterForTests) return heicConverterForTests(file);
  const { heicTo } = await import("heic-to");
  const out = await heicTo({
    blob: file,
    type: "image/jpeg",
    quality: 1,
  });
  if (!(out instanceof Blob) || out.size <= 0) {
    throw new Error("convert_failed");
  }
  return out;
}

export async function decodeCourseReportPhotoSource(file: File): Promise<Blob> {
  if (!isHeicLikeFile(file)) return file;
  try {
    return await convertHeicToJpegBlob(file);
  } catch {
    throw new Error(COURSE_REPORT_HEIC_CONVERT_MESSAGE);
  }
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

function hasTransparentPixels(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext("2d");
  if (!ctx) return false;
  const { width, height } = canvas;
  const sampleW = Math.min(width, 64);
  const sampleH = Math.min(height, 64);
  const data = ctx.getImageData(0, 0, sampleW, sampleH).data;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

export async function prepareCourseReportPhoto(file: File): Promise<Blob> {
  if (file.size > COURSE_REPORT_PHOTO_MAX_BYTES * 4) {
    throw new Error("사진이 너무 큽니다.");
  }
  const source = await decodeCourseReportPhotoSource(file);
  let img: HTMLImageElement;
  try {
    img = await loadImage(source);
  } catch {
    throw new Error(
      isHeicLikeFile(file) ? COURSE_REPORT_HEIC_CONVERT_MESSAGE : COURSE_REPORT_HEIC_MESSAGE
    );
  }
  const longEdge = Math.max(img.width, img.height) || 1;
  const scale = Math.min(1, COURSE_REPORT_PHOTO_LONG_EDGE / longEdge);
  const width = Math.max(1, Math.round(img.width * scale));
  const height = Math.max(1, Math.round(img.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("encode_failed");
  ctx.drawImage(img, 0, 0, width, height);

  const type = (source.type || file.type || "").toLowerCase();
  if (type === "image/png" && hasTransparentPixels(canvas)) {
    const blob = await canvasToBlob(canvas, "image/png");
    if (blob.size > COURSE_REPORT_PHOTO_MAX_BYTES) {
      throw new Error("사진은 장당 3MB 이하만 첨부할 수 있습니다.");
    }
    return blob;
  }
  const blob = await canvasToBlob(
    canvas,
    "image/jpeg",
    COURSE_REPORT_PHOTO_JPEG_QUALITY
  );
  if (blob.size > COURSE_REPORT_PHOTO_MAX_BYTES) {
    throw new Error("사진은 장당 3MB 이하만 첨부할 수 있습니다.");
  }
  return blob;
}

export type CourseReportPendingPick = { key: string; blob: Blob; previewUrl: string };

export async function pickCourseReportPhotos(
  files: File[],
  room: number,
  prepare: (file: File) => Promise<Blob> = prepareCourseReportPhoto
): Promise<{ items: CourseReportPendingPick[]; note: string }> {
  const selected = files.slice(0, Math.max(0, room));
  const items: CourseReportPendingPick[] = [];
  let note = "";
  for (const file of selected) {
    try {
      const blob = await prepare(file);
      items.push({
        key: `${Date.now()}-${items.length}-${file.name}`,
        blob,
        previewUrl: URL.createObjectURL(blob),
      });
    } catch (e) {
      note = e instanceof Error ? e.message : COURSE_REPORT_HEIC_CONVERT_MESSAGE;
    }
  }
  return { items, note };
}

export {
  COURSE_REPORT_PHOTO_ACCEPT,
  COURSE_REPORT_PHOTO_MAX,
};
