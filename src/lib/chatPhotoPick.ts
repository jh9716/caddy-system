import {
  COURSE_REPORT_HEIC_CONVERT_MESSAGE,
  COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE,
  courseReportPhotoBlobFingerprint,
  courseReportPhotoFileId,
  prepareCourseReportPhoto,
} from "@/lib/courseReportPhotoClient";
import { CHAT_PHOTO_MAX } from "@/lib/chatPhotoConstants";

export const CHAT_PHOTO_UPLOAD_CONCURRENCY = 3;

export type ChatPendingPhotoStatus = "preparing" | "ready" | "failed";

export type ChatPendingPhoto = {
  key: string;
  blob: Blob;
  previewUrl: string;
  fileId: string;
  fingerprint: string;
  status: ChatPendingPhotoStatus;
  error?: string;
};

export function instantChatPhotoPicks(
  files: File[],
  room: number,
  already: { fileIds?: Iterable<string> } = {}
): { items: ChatPendingPhoto[]; sources: File[]; note: string } {
  const seenIds = new Set(already.fileIds ?? []);
  const items: ChatPendingPhoto[] = [];
  const sources: File[] = [];
  let note = "";
  for (const file of files) {
    if (items.length >= Math.max(0, room)) break;
    const fileId = courseReportPhotoFileId(file);
    if (seenIds.has(fileId)) {
      note = COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE;
      continue;
    }
    seenIds.add(fileId);
    items.push({
      key: `${Date.now()}-${items.length}-${fileId}`,
      blob: file,
      previewUrl: URL.createObjectURL(file),
      fileId,
      fingerprint: "",
      status: "preparing",
    });
    sources.push(file);
  }
  return { items, sources, note };
}

export async function prepareChatPendingPhoto(
  item: ChatPendingPhoto,
  file: File,
  prepare: (file: File) => Promise<Blob> = prepareCourseReportPhoto
): Promise<ChatPendingPhoto> {
  try {
    const blob = await prepare(file);
    const fingerprint = await courseReportPhotoBlobFingerprint(blob);
    return {
      ...item,
      blob,
      fingerprint,
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

export function applyPreparedChatPhoto(
  prev: ChatPendingPhoto[],
  prepared: ChatPendingPhoto
): { items: ChatPendingPhoto[]; note: string } {
  const current = prev.find((row) => row.key === prepared.key);
  if (!current) return { items: prev, note: "" };
  if (prepared.status === "failed") {
    return {
      items: prev.map((row) => (row.key === prepared.key ? prepared : row)),
      note: prepared.error || COURSE_REPORT_HEIC_CONVERT_MESSAGE,
    };
  }
  if (
    prepared.fingerprint &&
    prev.some(
      (row) =>
        row.key !== prepared.key &&
        row.status === "ready" &&
        row.fingerprint === prepared.fingerprint
    )
  ) {
    URL.revokeObjectURL(current.previewUrl);
    return {
      items: prev.filter((row) => row.key !== prepared.key),
      note: COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE,
    };
  }
  return {
    items: prev.map((row) =>
      row.key === prepared.key
        ? { ...row, blob: prepared.blob, fingerprint: prepared.fingerprint, status: "ready" }
        : row
    ),
    note: "",
  };
}

export async function mapBoundedSettled<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<PromiseSettledResult<R>[]> {
  const results: PromiseSettledResult<R>[] = new Array(items.length);
  let next = 0;
  const workers = Math.max(1, Math.min(limit, items.length || 1));
  async function worker() {
    while (next < items.length) {
      const index = next;
      next += 1;
      try {
        results[index] = { status: "fulfilled", value: await fn(items[index], index) };
      } catch (reason) {
        results[index] = { status: "rejected", reason };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(workers, Math.max(items.length, 1)) }, () => worker()));
  return results;
}

export function readyChatPhotosForUpload(items: readonly ChatPendingPhoto[]): ChatPendingPhoto[] {
  return items.filter((item) => item.status === "ready" && item.blob && item.blob.size > 0);
}

export function chatPhotoPickRoom(currentCount: number, max = CHAT_PHOTO_MAX): number {
  return Math.max(0, max - currentCount);
}
