import {
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
} from "@/lib/courseReportPhotoClient";
import { CHAT_PHOTO_MAX_BYTES, CHAT_PHOTO_PASSTHROUGH_MAX_BYTES } from "@/lib/chatPhotoConstants";
import {
  bindChatPhotoTimingFile,
  chatPhotoTimingRunIdFor,
  noteChatPhotoBoundary,
  noteChatPhotoPrepareScope,
} from "@/lib/chatPhotoTiming";

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
  if (!Number.isFinite(file.size) || file.size <= 0 || file.size > CHAT_PHOTO_PASSTHROUGH_MAX_BYTES) {
    return false;
  }
  if (file.size > CHAT_PHOTO_MAX_BYTES) return false;
  const kind = chatPhotoSourceKind(file);
  return kind === "jpeg" || kind === "png" || kind === "webp";
}

export function needsChatPhotoHeavyPrepare(file: { name?: string; type?: string; size: number }): boolean {
  if (isHeicLikeFile(file as File) || chatPhotoSourceKind(file) === "heic") return true;
  const kind = chatPhotoSourceKind(file);
  if (kind === "unknown") return false;
  return file.size > CHAT_PHOTO_PASSTHROUGH_MAX_BYTES;
}

export function isChatPhotoAcceptableSource(file: { name?: string; type?: string; size: number }): boolean {
  if (!Number.isFinite(file.size) || file.size <= 0) return false;
  return chatPhotoSourceKind(file) !== "unknown";
}

export async function prepareChatPhotoSource(
  file: File,
  compress?: (file: File) => Promise<Blob>
): Promise<Blob> {
  const runId = chatPhotoTimingRunIdFor(file);
  noteChatPhotoBoundary(runId, "photoSourceEnterAt");
  try {
    if (!isChatPhotoAcceptableSource(file)) {
      throw new Error(COURSE_REPORT_HEIC_MESSAGE);
    }
    if (canUseChatPhotoFastPath(file)) {
      return file;
    }
    const run =
      compress ||
      (await import("@/lib/chatPhotoAdaptive")).prepareChatAdaptiveBlob;
    if (isHeicLikeFile(file) || chatPhotoSourceKind(file) === "heic") {
      const converted = await decodeCourseReportPhotoSource(file);
      const convertedFile = new File(
        [converted],
        (file.name || "photo").replace(/\.(heic|heif)$/i, ".jpg"),
        {
          type: converted.type || "image/jpeg",
          lastModified: file.lastModified,
        }
      );
      if (runId) bindChatPhotoTimingFile(convertedFile, runId);
      noteChatPhotoPrepareScope(runId, { jpegDirectRun: false, sameFileBound: false });
      if (canUseChatPhotoFastPath(convertedFile)) return converted;
      return await run(convertedFile);
    }
    noteChatPhotoPrepareScope(runId, { jpegDirectRun: true, sameFileBound: Boolean(runId) });
    return await run(file);
  } finally {
    noteChatPhotoBoundary(runId, "photoSourceExitAt");
  }
}
