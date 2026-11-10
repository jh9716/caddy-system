import {
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
} from "@/lib/courseReportPhotoClient";
import { CHAT_PHOTO_MAX_BYTES, CHAT_PHOTO_PASSTHROUGH_MAX_BYTES } from "@/lib/chatPhotoConstants";
import {
  bindChatPhotoTimingFile,
  chatPhotoTimingRunIdFor,
  isChatPhotoDebugTiming,
  noteChatPhotoBoundary,
  noteChatPhotoFileAccess,
  noteChatPhotoPrepareScope,
  noteChatPhotoSourceSplit,
  watchChatPhotoFileAccess,
} from "@/lib/chatPhotoTiming";

export type ChatPhotoSourceKind = "jpeg" | "png" | "webp" | "heic" | "unknown";

export type ChatPhotoFileMeta = {
  type: string;
  name: string;
  size: number;
};

export type ChatPhotoSourcePlan = {
  acceptable: boolean;
  fastPath: boolean;
  heic: boolean;
  kind: ChatPhotoSourceKind;
};

/** One snapshot of File metadata for prepareChatPhotoSource. */
export function readChatPhotoFileMeta(file: { name?: string; type?: string; size?: number }): ChatPhotoFileMeta {
  return {
    type: (file.type || "").toLowerCase(),
    name: (file.name || "").toLowerCase(),
    size: Number(file.size),
  };
}

export function chatPhotoSourceKindFromParts(type: string, name: string): ChatPhotoSourceKind {
  const normalizedType = (type || "").toLowerCase();
  const normalizedName = (name || "").toLowerCase();
  if (
    normalizedType.includes("heic") ||
    normalizedType.includes("heif") ||
    normalizedName.endsWith(".heic") ||
    normalizedName.endsWith(".heif")
  ) {
    return "heic";
  }
  if (
    normalizedType === "image/jpeg" ||
    normalizedType === "image/jpg" ||
    normalizedName.endsWith(".jpg") ||
    normalizedName.endsWith(".jpeg")
  ) {
    return "jpeg";
  }
  if (normalizedType === "image/png" || normalizedName.endsWith(".png")) return "png";
  if (normalizedType === "image/webp" || normalizedName.endsWith(".webp")) return "webp";
  return "unknown";
}

export function chatPhotoSourceKindFromMeta(meta: ChatPhotoFileMeta): ChatPhotoSourceKind {
  return chatPhotoSourceKindFromParts(meta.type, meta.name);
}

export function isHeicLikeFromMeta(meta: ChatPhotoFileMeta): boolean {
  return (
    meta.type.includes("heic") ||
    meta.type.includes("heif") ||
    meta.name.endsWith(".heic") ||
    meta.name.endsWith(".heif")
  );
}

export function canUseChatPhotoFastPathFromMeta(meta: ChatPhotoFileMeta): boolean {
  if (!Number.isFinite(meta.size) || meta.size <= 0 || meta.size > CHAT_PHOTO_PASSTHROUGH_MAX_BYTES) {
    return false;
  }
  if (meta.size > CHAT_PHOTO_MAX_BYTES) return false;
  const kind = chatPhotoSourceKindFromMeta(meta);
  return kind === "jpeg" || kind === "png" || kind === "webp";
}

export function isChatPhotoAcceptableSourceFromMeta(meta: ChatPhotoFileMeta): boolean {
  if (!Number.isFinite(meta.size) || meta.size <= 0) return false;
  return chatPhotoSourceKindFromMeta(meta) !== "unknown";
}

/** Same decisions as the live helpers, from one type/name/size read. */
export function planChatPhotoSourceFromMeta(meta: ChatPhotoFileMeta): ChatPhotoSourcePlan {
  const kind = chatPhotoSourceKindFromMeta(meta);
  return {
    acceptable: isChatPhotoAcceptableSourceFromMeta(meta),
    fastPath: canUseChatPhotoFastPathFromMeta(meta),
    heic: isHeicLikeFromMeta(meta),
    kind,
  };
}

export function chatPhotoSourceKind(file: { name?: string; type?: string }): ChatPhotoSourceKind {
  const type = (file.type || "").toLowerCase();
  const name = (file.name || "").toLowerCase();
  return chatPhotoSourceKindFromParts(type, name);
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
  const debug = isChatPhotoDebugTiming();
  const runId = debug ? chatPhotoTimingRunIdFor(file) : null;
  if (debug) noteChatPhotoBoundary(runId, "photoSourceEnterAt");
  const watch = debug ? watchChatPhotoFileAccess(file) : null;
  const probed = watch ? watch.file : file;
  const flushWatch = () => {
    if (watch) noteChatPhotoFileAccess(runId, watch);
  };
  try {
    const meta = readChatPhotoFileMeta(probed);
    const plan = planChatPhotoSourceFromMeta(meta);
    if (!plan.acceptable) {
      flushWatch();
      throw new Error(COURSE_REPORT_HEIC_MESSAGE);
    }
    if (debug) noteChatPhotoSourceSplit(runId, "sourceAcceptableEndAt");
    flushWatch();
    if (plan.fastPath) {
      if (debug) noteChatPhotoSourceSplit(runId, "sourceFastPathEndAt");
      flushWatch();
      return file;
    }
    if (debug) noteChatPhotoSourceSplit(runId, "sourceFastPathEndAt");
    flushWatch();
    const run =
      compress ||
      (await import("@/lib/chatPhotoAdaptive")).prepareChatAdaptiveBlob;
    if (debug) noteChatPhotoSourceSplit(runId, "sourceRunResolveEndAt");
    const heicLike = plan.heic;
    if (debug) noteChatPhotoSourceSplit(runId, "sourceHeicEndAt");
    flushWatch();
    const kindHeic = heicLike || plan.kind === "heic";
    if (debug) noteChatPhotoSourceSplit(runId, "sourceKindEndAt");
    flushWatch();
    if (kindHeic) {
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
      if (debug) {
        noteChatPhotoPrepareScope(runId, { jpegDirectRun: false, sameFileBound: false });
        noteChatPhotoSourceSplit(runId, "sourceNoteScopeEndAt");
        flushWatch();
      }
      const convertedPlan = planChatPhotoSourceFromMeta(readChatPhotoFileMeta(convertedFile));
      if (convertedPlan.fastPath) return converted;
      if (debug) noteChatPhotoSourceSplit(runId, "sourceRunInvokeAt");
      return await run(convertedFile);
    }
    if (debug) {
      noteChatPhotoPrepareScope(runId, { jpegDirectRun: true, sameFileBound: Boolean(runId) });
      noteChatPhotoSourceSplit(runId, "sourceNoteScopeEndAt");
      flushWatch();
      noteChatPhotoSourceSplit(runId, "sourceRunInvokeAt");
    }
    return await run(file);
  } finally {
    if (debug) noteChatPhotoBoundary(runId, "photoSourceExitAt");
  }
}
