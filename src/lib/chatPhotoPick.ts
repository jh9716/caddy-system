import {
  COURSE_REPORT_HEIC_CONVERT_MESSAGE,
  COURSE_REPORT_HEIC_MESSAGE,
  COURSE_REPORT_PHOTO_DUPLICATE_MESSAGE,
  courseReportPhotoFileId,
} from "@/lib/courseReportPhotoClient";
import type { ChatPhotoDirectResult } from "@/lib/chatPhotoDirectClient";
import { CHAT_PHOTO_MAX } from "@/lib/chatPhotoConstants";
import { prepareChatAdaptiveBlob } from "@/lib/chatPhotoAdaptive";
import {
  canUseChatPhotoFastPath,
  isChatPhotoAcceptableSource,
  prepareChatPhotoSource,
} from "@/lib/chatPhotoFastPath";
import { chatPhotoNow } from "@/lib/chatPhotoTiming";

export const CHAT_PHOTO_UPLOAD_CONCURRENCY = 3;

export type ChatPendingPhotoStatus = "preparing" | "ready" | "failed";
export type ChatPhotoSendPhase = "idle" | "prepare" | "put" | "finalize" | "done" | "error";

export type ChatPendingPhotoSend = {
  phase: ChatPhotoSendPhase;
  progress: number;
  attachmentId?: string;
  result?: ChatPhotoDirectResult;
  error?: string;
};

export type ChatPhotoMetrics = {
  sourceBytes: number;
  uploadBytes?: number;
  compressionMs?: number;
};

export type ChatPendingPhoto = {
  key: string;
  blob: Blob;
  previewUrl: string;
  fileId: string;
  fingerprint: string;
  status: ChatPendingPhotoStatus;
  error?: string;
  send?: ChatPendingPhotoSend;
  metrics?: ChatPhotoMetrics;
};

export function chatPhotoComposerBusy(item: ChatPendingPhoto): boolean {
  if (item.status === "failed" || item.send?.phase === "error" || item.send?.phase === "done") {
    return false;
  }
  return item.status === "preparing" || Boolean(item.send && item.send.phase !== "idle");
}

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
    if (!isChatPhotoAcceptableSource(file)) {
      note = COURSE_REPORT_HEIC_MESSAGE;
      continue;
    }
    seenIds.add(fileId);
    items.push({
      key: `${Date.now()}-${items.length}-${fileId}`,
      blob: file,
      previewUrl: URL.createObjectURL(file),
      fileId,
      fingerprint: "",
      status: canUseChatPhotoFastPath(file) ? "ready" : "preparing",
      metrics: { sourceBytes: file.size, uploadBytes: canUseChatPhotoFastPath(file) ? file.size : undefined, compressionMs: canUseChatPhotoFastPath(file) ? 0 : undefined },
    });
    sources.push(file);
  }
  return { items, sources, note };
}

export async function prepareChatPendingPhoto(
  item: ChatPendingPhoto,
  file: File,
  prepare: (file: File) => Promise<Blob> = (next) => prepareChatPhotoSource(next, prepareChatAdaptiveBlob)
): Promise<ChatPendingPhoto> {
  try {
    if (canUseChatPhotoFastPath(file) && prepare === prepareChatPhotoSource) {
      return {
        ...item,
        blob: file,
        fingerprint: "",
        status: "ready",
        error: undefined,
        metrics: { sourceBytes: file.size, uploadBytes: file.size, compressionMs: 0 },
      };
    }
    const started = chatPhotoNow();
    const blob = await prepare(file);
    return {
      ...item,
      blob,
      fingerprint: "",
      status: "ready",
      error: undefined,
      metrics: {
        sourceBytes: item.metrics?.sourceBytes ?? file.size,
        uploadBytes: blob.size,
        compressionMs: Math.max(0, chatPhotoNow() - started),
      },
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
        ? {
            ...row,
            blob: prepared.blob,
            fingerprint: prepared.fingerprint,
            status: "ready",
            send: row.send,
            metrics: prepared.metrics ?? row.metrics,
          }
        : row
    ),
    note: "",
  };
}

export function applyChatPhotoSendProgress(
  prev: ChatPendingPhoto[],
  progress: {
    key: string;
    phase: ChatPhotoSendPhase;
    progress: number;
    attachmentId?: string;
    error?: string;
    result?: ChatPhotoDirectResult;
  }
): ChatPendingPhoto[] {
  return prev.map((row) =>
    row.key === progress.key
      ? {
          ...row,
          send: {
            phase: progress.phase,
            progress: progress.progress,
            attachmentId: progress.attachmentId ?? row.send?.attachmentId,
            result: progress.result ?? row.send?.result,
            error: progress.error,
          },
        }
      : row
  );
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
