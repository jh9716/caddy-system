import {
  COURSE_REPORT_HEIC_MESSAGE,
  decodeCourseReportPhotoSource,
  isHeicLikeFile,
} from "@/lib/courseReportPhotoClient";
import { CHAT_PHOTO_MAX_BYTES, CHAT_PHOTO_PASSTHROUGH_MAX_BYTES } from "@/lib/chatPhotoConstants";
import { noteChatPhotoLiteStamp } from "@/lib/chatPhotoLiteTiming";
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

/** One snapshot of File metadata. Picker carries this into prepare/adaptive. */
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

export type ChatPhotoSourceCarry = {
  sourceMeta?: ChatPhotoFileMeta | null;
  sourcePlan?: ChatPhotoSourcePlan | null;
};

export function carriedChatPhotoSourcePlan(
  carry?: ChatPhotoSourceCarry | null
): ChatPhotoSourcePlan | null {
  if (carry?.sourcePlan) return carry.sourcePlan;
  if (carry?.sourceMeta) return planChatPhotoSourceFromMeta(carry.sourceMeta);
  return null;
}

export async function prepareChatPhotoSource(
  file: File,
  compress?: (file: File) => Promise<Blob>,
  carry?: ChatPhotoSourceCarry | null
): Promise<Blob> {
  noteChatPhotoLiteStamp("sourceEnterAt");
  const debug = isChatPhotoDebugTiming();
  const runId = debug ? chatPhotoTimingRunIdFor(file) : null;
  if (debug) noteChatPhotoBoundary(runId, "photoSourceEnterAt");
  const carried = carriedChatPhotoSourcePlan(carry);
  const watch = !carried && debug ? watchChatPhotoFileAccess(file) : null;
  const probed = watch ? watch.file : file;
  const flushWatch = () => {
    if (watch) noteChatPhotoFileAccess(runId, watch);
  };
  const run =
    compress ||
    ((next: File) =>
      import("@/lib/chatPhotoAdaptive").then((mod) =>
        mod.prepareChatAdaptiveBlob(next, next === file ? carry : undefined)
      ));
  try {
    if (carried) {
      if (!carried.acceptable) {
        throw new Error(COURSE_REPORT_HEIC_MESSAGE);
      }
      if (debug) noteChatPhotoSourceSplit(runId, "sourceAcceptableEndAt");
      if (carried.fastPath) {
        if (debug) noteChatPhotoSourceSplit(runId, "sourceFastPathEndAt");
        return file;
      }
      if (debug) noteChatPhotoSourceSplit(runId, "sourceFastPathEndAt");
      if (debug) noteChatPhotoSourceSplit(runId, "sourceRunResolveEndAt");
      if (debug) noteChatPhotoSourceSplit(runId, "sourceHeicEndAt");
      const kindHeic = carried.heic || carried.kind === "heic";
      if (debug) noteChatPhotoSourceSplit(runId, "sourceKindEndAt");
      if (kindHeic) {
        const converted = await decodeCourseReportPhotoSource(file);
        const convertedFile = new File(
          [converted],
          (carry?.sourceMeta?.name || file.name || "photo").replace(/\.(heic|heif)$/i, ".jpg"),
          {
            type: converted.type || "image/jpeg",
            lastModified: file.lastModified,
          }
        );
        if (runId) bindChatPhotoTimingFile(convertedFile, runId);
        if (debug) {
          noteChatPhotoPrepareScope(runId, { jpegDirectRun: false, sameFileBound: false });
          noteChatPhotoSourceSplit(runId, "sourceNoteScopeEndAt");
        }
        if (canUseChatPhotoFastPath(convertedFile)) return converted;
        if (debug) noteChatPhotoSourceSplit(runId, "sourceRunInvokeAt");
        noteChatPhotoLiteStamp("sourceBeforeRunAt");
        const convertedOut = await run(convertedFile);
        noteChatPhotoLiteStamp("sourceExitAt");
        return convertedOut;
      }
      if (debug) {
        noteChatPhotoPrepareScope(runId, { jpegDirectRun: true, sameFileBound: Boolean(runId) });
        noteChatPhotoSourceSplit(runId, "sourceNoteScopeEndAt");
        noteChatPhotoSourceSplit(runId, "sourceRunInvokeAt");
      }
      noteChatPhotoLiteStamp("sourceBeforeRunAt");
      const jpegOut = await run(file);
      noteChatPhotoLiteStamp("sourceExitAt");
      return jpegOut;
    }
    if (!isChatPhotoAcceptableSource(probed)) {
      flushWatch();
      throw new Error(COURSE_REPORT_HEIC_MESSAGE);
    }
    if (debug) noteChatPhotoSourceSplit(runId, "sourceAcceptableEndAt");
    flushWatch();
    if (canUseChatPhotoFastPath(probed)) {
      if (debug) noteChatPhotoSourceSplit(runId, "sourceFastPathEndAt");
      flushWatch();
      return file;
    }
    if (debug) noteChatPhotoSourceSplit(runId, "sourceFastPathEndAt");
    flushWatch();
    if (debug) noteChatPhotoSourceSplit(runId, "sourceRunResolveEndAt");
    const heicLike = isHeicLikeFile(probed);
    if (debug) noteChatPhotoSourceSplit(runId, "sourceHeicEndAt");
    flushWatch();
    const kindHeic = heicLike || chatPhotoSourceKind(probed) === "heic";
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
      if (canUseChatPhotoFastPath(convertedFile)) return converted;
      if (debug) noteChatPhotoSourceSplit(runId, "sourceRunInvokeAt");
      noteChatPhotoLiteStamp("sourceBeforeRunAt");
      const convertedOut = await run(convertedFile);
      noteChatPhotoLiteStamp("sourceExitAt");
      return convertedOut;
    }
    if (debug) {
      noteChatPhotoPrepareScope(runId, { jpegDirectRun: true, sameFileBound: Boolean(runId) });
      noteChatPhotoSourceSplit(runId, "sourceNoteScopeEndAt");
      flushWatch();
      noteChatPhotoSourceSplit(runId, "sourceRunInvokeAt");
    }
    noteChatPhotoLiteStamp("sourceBeforeRunAt");
    const jpegOut = await run(file);
    noteChatPhotoLiteStamp("sourceExitAt");
    return jpegOut;
  } finally {
    if (debug) noteChatPhotoBoundary(runId, "photoSourceExitAt");
  }
}
