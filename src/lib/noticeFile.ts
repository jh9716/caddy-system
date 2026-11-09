import { randomUUID } from "node:crypto";
import { Prisma, type NoticeFile, type PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import { canWriteInternalNotice } from "@/lib/noticeAccess";
import { canViewNotice } from "@/lib/noticeTarget";
import {
  CourseReportPhotoStorageError,
  getCourseReportPhotoStore,
} from "@/lib/courseReportPhotoStorage";
import { lockNoticeRow, resolveLockedSortOrder } from "@/lib/noticeMediaLock";
import {
  NOTICE_FILE_EXT,
  NOTICE_FILE_MAX,
  NOTICE_FILE_MIME,
  noticeFileLimitMessage,
  sanitizeNoticeFileName,
  type NoticeFilePublic,
} from "@/lib/noticeFileConstants";
import {
  NoticeFileValidationError,
  assertNoticePdfBytes,
} from "@/lib/noticeFileMagic";

export type { NoticeFilePublic } from "@/lib/noticeFileConstants";
export { noticeFileSrc, sanitizeNoticeFileName } from "@/lib/noticeFileConstants";
export { NoticeFileValidationError } from "@/lib/noticeFileMagic";

export function isNoticeFileTableMissing(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2010")
  ) {
    const meta = e.meta && typeof e.meta === "object" ? e.meta : null;
    const table = meta && "table" in meta ? String(meta.table ?? "") : "";
    if (/NoticeFile/i.test(table)) return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /NoticeFile/i.test(msg) && /does not exist|relation|table/i.test(msg);
}

function fileTableNotReady(): never {
  throw new CourseReportPhotoStorageError(
    "file_table_not_ready",
    "첨부파일 기능이 아직 준비되지 않았습니다.",
    503
  );
}

export function toNoticeFilePublic(row: NoticeFile): NoticeFilePublic {
  return {
    id: row.id,
    originalName: row.originalName,
    mimeType: row.mimeType,
    size: row.size,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export function canManageNoticeFiles(role: ResolvedAuthUser["role"]): boolean {
  return canWriteInternalNotice(role);
}

export function buildNoticeFileStorageKey(noticeId: number, id = randomUUID()): string {
  return `notices/${noticeId}/files/${id}.${NOTICE_FILE_EXT}`;
}

export function noticeFileContentDisposition(
  originalName: string,
  disposition: "inline" | "attachment"
): string {
  const filename = sanitizeNoticeFileName(originalName);
  const fallback = filename.replace(/[^\x20-\x7E]/g, "_");
  const encoded = encodeURIComponent(filename).replace(
    /[!'()*]/g,
    (ch) => `%${ch.charCodeAt(0).toString(16).toUpperCase()}`
  );
  return `${disposition}; filename="${fallback}"; filename*=UTF-8''${encoded}`;
}

export async function listNoticeFiles(
  db: PrismaClient,
  noticeId: number
): Promise<NoticeFilePublic[]> {
  try {
    const rows = await db.noticeFile.findMany({
      where: { noticeId },
      orderBy: { sortOrder: "asc" },
    });
    return rows.map(toNoticeFilePublic);
  } catch (e) {
    if (isNoticeFileTableMissing(e)) return [];
    throw e;
  }
}

export async function countNoticeFiles(db: PrismaClient, noticeId: number): Promise<number> {
  try {
    return await db.noticeFile.count({ where: { noticeId } });
  } catch (e) {
    if (isNoticeFileTableMissing(e)) return 0;
    throw e;
  }
}

export async function listNoticeFileStorageKeys(
  db: PrismaClient,
  noticeId: number
): Promise<string[]> {
  try {
    const rows = await db.noticeFile.findMany({
      where: { noticeId },
      select: { storageKey: true },
    });
    return rows.map((row) => row.storageKey);
  } catch (e) {
    if (isNoticeFileTableMissing(e)) return [];
    throw e;
  }
}

export async function uploadNoticeFile(
  db: PrismaClient,
  input: {
    noticeId: number;
    bytes: Uint8Array;
    originalName?: string;
    auth: ResolvedAuthUser;
    requestedSortOrder?: number | null;
  }
): Promise<NoticeFilePublic> {
  if (!canManageNoticeFiles(input.auth.role)) {
    throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
  }
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "첨부파일 저장소가 설정되지 않았습니다.",
      503
    );
  }

  const notice = await db.notice.findUnique({ where: { id: input.noticeId } });
  if (!notice) {
    throw new NoticeFileValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }

  const mime = assertNoticePdfBytes(input.bytes);
  const originalName = sanitizeNoticeFileName(input.originalName);
  const storageKey = buildNoticeFileStorageKey(input.noticeId);
  try {
    await store.put(storageKey, input.bytes, mime);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError(
      "storage_put_failed",
      "첨부파일 저장에 실패했습니다.",
      502
    );
  }

  let row: NoticeFile;
  try {
    row = await db.$transaction(async (tx) => {
      const locked = await lockNoticeRow(tx, input.noticeId);
      if (!locked) {
        throw new NoticeFileValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
      }
      let existing: number;
      try {
        existing = await tx.noticeFile.count({ where: { noticeId: input.noticeId } });
      } catch (e) {
        if (isNoticeFileTableMissing(e)) fileTableNotReady();
        throw e;
      }
      if (existing >= NOTICE_FILE_MAX) {
        throw new NoticeFileValidationError("file_limit", noticeFileLimitMessage(), 409);
      }
      const agg = await tx.noticeFile.aggregate({
        where: { noticeId: input.noticeId },
        _max: { sortOrder: true },
      });
      const requested = input.requestedSortOrder ?? null;
      const taken =
        requested != null
          ? Boolean(
              await tx.noticeFile.findFirst({
                where: { noticeId: input.noticeId, sortOrder: requested },
                select: { id: true },
              })
            )
          : false;
      return tx.noticeFile.create({
        data: {
          noticeId: input.noticeId,
          storageKey,
          originalName,
          mimeType: mime,
          size: input.bytes.byteLength,
          sortOrder: resolveLockedSortOrder(agg._max.sortOrder, requested, taken),
        },
      });
    });
  } catch (e) {
    await store.delete(storageKey).catch(() => undefined);
    if (e instanceof NoticeFileValidationError) throw e;
    if (isNoticeFileTableMissing(e)) fileTableNotReady();
    throw e;
  }
  return toNoticeFilePublic(row);
}

export async function cleanupNoticeFileBlobsBestEffort(
  keys: string[],
  context?: { noticeId?: number; fileId?: number }
): Promise<{ failed: string[] }> {
  const store = getCourseReportPhotoStore();
  if (!store.configured) return { failed: [] };
  const failed: string[] = [];
  for (const storageKey of keys) {
    try {
      await store.delete(storageKey);
    } catch (e) {
      failed.push(storageKey);
      console.error("[notice-file] orphan blob cleanup failed", {
        noticeId: context?.noticeId ?? null,
        fileId: context?.fileId ?? null,
        storageKey,
        error: e instanceof Error ? e.message : String(e ?? ""),
      });
    }
  }
  return { failed };
}

export async function deleteNoticeFile(
  db: PrismaClient,
  input: {
    noticeId: number;
    fileId: number;
    auth: ResolvedAuthUser;
  }
): Promise<{ blobCleanupFailed: boolean }> {
  if (!canManageNoticeFiles(input.auth.role)) {
    throw new NoticeFileValidationError("forbidden", "첨부파일을 삭제할 수 없습니다.", 403);
  }
  const notice = await db.notice.findUnique({ where: { id: input.noticeId } });
  if (!notice) {
    throw new NoticeFileValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }

  let file: NoticeFile | null;
  try {
    file = await db.noticeFile.findUnique({ where: { id: input.fileId } });
  } catch (e) {
    if (isNoticeFileTableMissing(e)) fileTableNotReady();
    throw e;
  }
  if (!file || file.noticeId !== input.noticeId) {
    throw new NoticeFileValidationError("not_found", "첨부파일을 찾을 수 없습니다.", 404);
  }

  try {
    await db.noticeFile.delete({ where: { id: file.id } });
  } catch (e) {
    if (isNoticeFileTableMissing(e)) fileTableNotReady();
    throw e;
  }

  const cleanup = await cleanupNoticeFileBlobsBestEffort([file.storageKey], {
    noticeId: input.noticeId,
    fileId: input.fileId,
  });
  return { blobCleanupFailed: cleanup.failed.length > 0 };
}

export async function loadNoticeFileMeta(
  db: PrismaClient,
  input: {
    noticeId: number;
    fileId: number;
    viewer: Parameters<typeof canViewNotice>[1];
  }
): Promise<NoticeFile> {
  const notice = await db.notice.findUnique({ where: { id: input.noticeId } });
  if (!notice || !canViewNotice(notice, input.viewer)) {
    throw new NoticeFileValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }
  let file: NoticeFile | null;
  try {
    file = await db.noticeFile.findUnique({ where: { id: input.fileId } });
  } catch (e) {
    if (isNoticeFileTableMissing(e)) fileTableNotReady();
    throw e;
  }
  if (!file || file.noticeId !== input.noticeId) {
    throw new NoticeFileValidationError("not_found", "첨부파일을 찾을 수 없습니다.", 404);
  }
  if (file.mimeType !== NOTICE_FILE_MIME) {
    throw new NoticeFileValidationError("unsupported_type", "PDF 파일만 열 수 있습니다.", 415);
  }
  return file;
}

export async function openNoticeFileBody(storageKey: string, abortSignal?: AbortSignal) {
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "첨부파일 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const opts = abortSignal ? { abortSignal } : undefined;
  const body = store.open
    ? await store.open(storageKey, opts)
    : await store.get(storageKey, opts);
  if (!body) {
    throw new NoticeFileValidationError("not_found", "첨부파일을 찾을 수 없습니다.", 404);
  }
  return body;
}
