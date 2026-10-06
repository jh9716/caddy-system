import {
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
  prepareCourseReportPhoto,
} from "@/lib/courseReportPhotoClient";
import { CHAT_PHOTO_MAX_BYTES } from "@/lib/chatPhotoConstants";

export type ChatPhotoSourceKind = "jpeg" | "png" | "webp" | "heic" | "unknown";

export function chatPhotoSourceKind(file: { name?: string; type?: string }): ChatPhotoSourceKind {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  if (type.includes("heic") || type.includes("heif") || name.endsWith(".heic") || name.endsWith(".heif")) {
    return "heic";
  }
  if (type === "image/jpeg" || type === "image/jpg" || name.endsWith(".jpg") || name.endsWith(".jpeg")) {
    return "jpeg";
  }
  if (type === "image/png" || name.endsWith(".png")) return "png";
  if (type === "image/webp" || name.endsWith(".webp")) return "webp";
  return "unknown";
}

export function canUseChatPhotoFastPath(file: { name?: string; type?: string; size: number }): boolean {
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > CHAT_PHOTO_MAX_BYTES) return false;
  const kind = chatPhotoSourceKind(file);
  return kind === "jpeg" || kind === "png" || kind === "webp";
}

export function needsChatPhotoHeavyPrepare(file: { name?: string; type?: string; size: number }): boolean {
  if (isHeicLikeFile(file as File) || chatPhotoSourceKind(file) === "heic") return true;
  if (file.size > CHAT_PHOTO_MAX_BYTES) {
    const kind = chatPhotoSourceKind(file);
    return kind === "jpeg" || kind === "png" || kind === "webp";
  }
  return false;
}

export function isChatPhotoAcceptableSource(file: { name?: string; type?: string; size: number }): boolean {
  if (!Number.isFinite(file.size) || file.size <= 0) return false;
  return chatPhotoSourceKind(file) !== "unknown";
}

export async function prepareChatPhotoSource(
  file: File,
  compress: (file: File) => Promise<Blob> = prepareCourseReportPhoto
): Promise<Blob> {
  if (!isChatPhotoAcceptableSource(file)) {
    throw new Error(COURSE_REPORT_HEIC_MESSAGE);
  }
  if (canUseChatPhotoFastPath(file)) {
    return file;
  }
  if (isHeicLikeFile(file) || chatPhotoSourceKind(file) === "heic") {
    const converted = await decodeCourseReportPhotoSource(file);
    if (converted.size <= CHAT_PHOTO_MAX_BYTES) return converted;
    return compress(
      new File([converted], (file.name || "photo").replace(/\.(heic|heif)$/i, ".jpg"), {
        type: "image/jpeg",
        lastModified: file.lastModified,
      })
    );
  }
  return compress(file);
}
