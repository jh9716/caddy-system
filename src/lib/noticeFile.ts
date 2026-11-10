import { createHash, randomUUID } from "node:crypto";
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
  NOTICE_FILE_LOCK_NS,
  NOTICE_FILE_MAGIC_PREFIX_BYTES,
  NOTICE_FILE_MAX,
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_MIME_BY_EXT,
  NOTICE_FILE_SIGNED_PUT_TTL_MS,
  NOTICE_FILE_TX_MAX_WAIT_MS,
  NOTICE_FILE_TX_TIMEOUT_MS,
  noticeFileExtFromMime,
  noticeFileExtFromName,
  noticeFileLimitMessage,
  noticeFileSizeMessage,
  noticeFileTypeMessage,
  sanitizeNoticeFileName,
  type NoticeFileExt,
  type NoticeFilePublic,
} from "@/lib/noticeFileConstants";
import {
  NoticeFileValidationError,
  assertNoticeFileBytes,
  detectNoticeFileKind,
} from "@/lib/noticeFileMagic";
import {
  assertNoticeFileGrantFresh,
  noticeFileActorKey,
  parseNoticeFileStorageKey,
  parseNoticeFileUploadSize,
  parseSignedNoticeFileGrant,
  signLocalNoticeFilePutUrl,
  signNoticeFileUploadGrant,
  type NoticeFileUploadGrant,
} from "@/lib/noticeFileGrant";

export type { NoticeFilePublic } from "@/lib/noticeFileConstants";
export { noticeFileSrc, sanitizeNoticeFileName } from "@/lib/noticeFileConstants";
export { NoticeFileValidationError } from "@/lib/noticeFileMagic";

export type NoticeFilePrepareResult = {
  storageKey: string;
  uploadUrl: string;
  grant: string;
  contentType: string;
  maxBytes: number;
  expiresAt: number;
  originalName: string;
};

function claimedNoticeFileExt(input: {
  originalName?: string | null;
  contentType?: string | null;
}): NoticeFileExt {
  const fromName = noticeFileExtFromName(input.originalName);
  const fromMime = noticeFileExtFromMime(input.contentType);
  if (fromName && fromMime && fromName !== fromMime) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  const ext = fromName ?? fromMime;
  if (!ext) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  return ext;
}

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

export function buildNoticeFileStorageKey(
  noticeId: number,
  ext: NoticeFileExt,
  id = randomUUID()
): string {
  return `notices/${noticeId}/files/${id}.${ext}`;
}

export function noticeFileContentDisposition(
  originalName: string,
  disposition: "inline" | "attachment",
  ext?: NoticeFileExt | null
): string {
  const filename = sanitizeNoticeFileName(
    originalName,
    ext ?? noticeFileExtFromName(originalName) ?? "pdf"
  );
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

async function requireWritableNotice(
  db: PrismaClient,
  noticeId: number,
  auth: ResolvedAuthUser
): Promise<void> {
  if (!canManageNoticeFiles(auth.role)) {
    throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
  }
  const notice = await db.notice.findUnique({ where: { id: noticeId } });
  if (!notice) {
    throw new NoticeFileValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }
}

function requireConfiguredStore() {
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "첨부파일 저장소가 설정되지 않았습니다.",
      503
    );
  }
  return store;
}

function noticeFileStorageLockKey(storageKey: string): number {
  const digest = createHash("sha256").update(storageKey).digest();
  return (digest[0]! << 24) | (digest[1]! << 16) | (digest[2]! << 8) | digest[3]!;
}

async function lockNoticeFileStorageKey(
  tx: Prisma.TransactionClient,
  storageKey: string
): Promise<void> {
  const key = noticeFileStorageLockKey(storageKey);
  // pg_advisory_xact_lock() returns void. Prisma $queryRaw cannot deserialize
  // that column (P2010). $executeRaw runs the SELECT, holds the lock until
  // COMMIT/ROLLBACK, and is the same pattern as notice/board push.
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(
    CAST(${NOTICE_FILE_LOCK_NS} AS integer),
    CAST(${key} AS integer)
  )`;
}

const NOTICE_FILE_TX_OPTS = {
  maxWait: NOTICE_FILE_TX_MAX_WAIT_MS,
  timeout: NOTICE_FILE_TX_TIMEOUT_MS,
} as const;

export async function prepareNoticeFileUpload(
  db: PrismaClient,
  input: {
    noticeId: number;
    originalName?: string | null;
    contentType?: string | null;
    size: unknown;
    auth: ResolvedAuthUser;
  }
): Promise<NoticeFilePrepareResult> {
  await requireWritableNotice(db, input.noticeId, input.auth);
  const store = requireConfiguredStore();
  const size = parseNoticeFileUploadSize(input.size);
  const ext = claimedNoticeFileExt({
    originalName: input.originalName,
    contentType: input.contentType,
  });
  const mime = NOTICE_FILE_MIME_BY_EXT[ext];
  const existing = await countNoticeFiles(db, input.noticeId);
  if (existing >= NOTICE_FILE_MAX) {
    throw new NoticeFileValidationError("file_limit", noticeFileLimitMessage(), 409);
  }
  const storageKey = buildNoticeFileStorageKey(input.noticeId, ext);
  const originalName = sanitizeNoticeFileName(input.originalName, ext);
  const unsignedGrant = {
    noticeId: input.noticeId,
    actor: noticeFileActorKey(input.auth),
    storageKey,
    ext,
    contentType: mime,
    maxBytes: size,
  };
  const signed = signNoticeFileUploadGrant(unsignedGrant);
  const grant: NoticeFileUploadGrant = { ...unsignedGrant, exp: signed.expiresAt };
  let uploadUrl: string;
  if (store.createSignedPutUrl) {
    try {
      const blob = await store.createSignedPutUrl({
        pathname: storageKey,
        contentType: mime,
        maximumSizeInBytes: size,
        validUntilMs: signed.expiresAt,
      });
      uploadUrl = blob.uploadUrl;
    } catch (e) {
      if (e instanceof CourseReportPhotoStorageError) throw e;
      throw new CourseReportPhotoStorageError(
        "signed_put_failed",
        "첨부파일 업로드 URL 발급에 실패했습니다.",
        502
      );
    }
  } else {
    uploadUrl = signLocalNoticeFilePutUrl(grant);
  }
  return {
    storageKey,
    uploadUrl,
    grant: signed.token,
    contentType: mime,
    maxBytes: size,
    expiresAt: signed.expiresAt,
    originalName,
  };
}

async function loadUploadedNoticeFileBytes(
  storageKey: string,
  ext: NoticeFileExt
): Promise<{ bytes: Uint8Array; size: number }> {
  const store = requireConfiguredStore();
  if (ext === "pdf" && store.readPrefixAndMeta) {
    const inspected = await store.readPrefixAndMeta(storageKey, NOTICE_FILE_MAGIC_PREFIX_BYTES);
    if (!inspected || inspected.size <= 0) {
      throw new NoticeFileValidationError("not_found", "첨부파일을 찾을 수 없습니다.", 404);
    }
    if (inspected.size > NOTICE_FILE_MAX_BYTES) {
      throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
    }
    const kind = detectNoticeFileKind(inspected.prefix);
    if (kind?.ext === "pdf") {
      return { bytes: inspected.prefix, size: inspected.size };
    }
  }
  const bytes = await store.get(storageKey);
  if (!bytes || bytes.byteLength === 0) {
    throw new NoticeFileValidationError("not_found", "첨부파일을 찾을 수 없습니다.", 404);
  }
  return { bytes, size: bytes.byteLength };
}

async function findExistingByStorageKey(
  db: PrismaClient | Prisma.TransactionClient,
  storageKey: string,
  noticeId: number
): Promise<NoticeFile | null> {
  try {
    const row = await db.noticeFile.findUnique({ where: { storageKey } });
    if (row && row.noticeId === noticeId) return row;
    return row ? row : null;
  } catch (e) {
    if (isNoticeFileTableMissing(e)) fileTableNotReady();
    throw e;
  }
}

async function deleteUnregisteredNoticeFileBlob(storageKey: string): Promise<void> {
  const store = getCourseReportPhotoStore();
  if (!store.configured) return;
  await store.delete(storageKey).catch(() => undefined);
}

/** Caller must already hold lockNoticeFileStorageKey(storageKey). */
async function deleteBlobIfRowMissing(
  db: PrismaClient | Prisma.TransactionClient,
  storageKey: string,
  noticeId: number
): Promise<void> {
  const raced = await findExistingByStorageKey(db, storageKey, noticeId).catch(() => null);
  if (!raced) await deleteUnregisteredNoticeFileBlob(storageKey);
}

/**
 * Re-check NoticeFile under the storage-key lock before deleting a blob.
 * Used after a failed complete so a sibling complete cannot register a row
 * whose object is then removed by this catch.
 */
export async function sweepUnregisteredNoticeFileBlob(
  db: PrismaClient,
  input: { storageKey: string; noticeId: number }
): Promise<void> {
  await db.$transaction(async (tx) => {
    await lockNoticeFileStorageKey(tx, input.storageKey);
    await deleteBlobIfRowMissing(tx, input.storageKey, input.noticeId);
  }, NOTICE_FILE_TX_OPTS);
}

export async function completeNoticeFileUpload(
  db: PrismaClient,
  input: {
    noticeId: number;
    grant: string;
    originalName?: string | null;
    auth: ResolvedAuthUser;
    requestedSortOrder?: number | null;
  }
): Promise<NoticeFilePublic> {
  await requireWritableNotice(db, input.noticeId, input.auth);
  const grant = parseSignedNoticeFileGrant(input.grant);
  if (grant.noticeId !== input.noticeId || grant.actor !== noticeFileActorKey(input.auth)) {
    throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
  }
  requireConfiguredStore();

  let row: NoticeFile;
  try {
    row = await db.$transaction(async (tx) => {
      await lockNoticeFileStorageKey(tx, grant.storageKey);
      const already = await findExistingByStorageKey(tx, grant.storageKey, input.noticeId);
      if (already) {
        if (already.noticeId !== input.noticeId) {
          throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
        }
        return already;
      }
      assertNoticeFileGrantFresh(grant);

      let inspected: { bytes: Uint8Array; size: number };
      try {
        inspected = await loadUploadedNoticeFileBytes(grant.storageKey, grant.ext);
      } catch (e) {
        await deleteUnregisteredNoticeFileBlob(grant.storageKey);
        throw e;
      }
      if (inspected.size > grant.maxBytes) {
        await deleteUnregisteredNoticeFileBlob(grant.storageKey);
        throw new NoticeFileValidationError("file_too_large", noticeFileSizeMessage());
      }
      let kind: { ext: NoticeFileExt; mime: string };
      try {
        kind = assertNoticeFileBytes(inspected.bytes, grant.ext);
      } catch (e) {
        await deleteUnregisteredNoticeFileBlob(grant.storageKey);
        throw e;
      }
      const originalName = sanitizeNoticeFileName(
        input.originalName || grant.storageKey,
        kind.ext
      );

      const locked = await lockNoticeRow(tx, input.noticeId);
      if (!locked) {
        throw new NoticeFileValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
      }
      const raced = await findExistingByStorageKey(tx, grant.storageKey, input.noticeId);
      if (raced) {
        if (raced.noticeId !== input.noticeId) {
          throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
        }
        return raced;
      }
      let existing: number;
      try {
        existing = await tx.noticeFile.count({ where: { noticeId: input.noticeId } });
      } catch (e) {
        if (isNoticeFileTableMissing(e)) fileTableNotReady();
        throw e;
      }
      if (existing >= NOTICE_FILE_MAX) {
        await deleteUnregisteredNoticeFileBlob(grant.storageKey);
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
          storageKey: grant.storageKey,
          originalName,
          mimeType: kind.mime,
          size: inspected.size,
          sortOrder: resolveLockedSortOrder(agg._max.sortOrder, requested, taken),
        },
      });
    }, NOTICE_FILE_TX_OPTS);
  } catch (e) {
    if (
      e instanceof Prisma.PrismaClientKnownRequestError &&
      e.code === "P2002"
    ) {
      const raced = await findExistingByStorageKey(db, grant.storageKey, input.noticeId);
      if (raced && raced.noticeId === input.noticeId) return toNoticeFilePublic(raced);
    }
    if (!(e instanceof NoticeFileValidationError) || e.code !== "forbidden") {
      await sweepUnregisteredNoticeFileBlob(db, {
        storageKey: grant.storageKey,
        noticeId: input.noticeId,
      }).catch(() => undefined);
    }
    if (e instanceof NoticeFileValidationError) throw e;
    if (isNoticeFileTableMissing(e)) fileTableNotReady();
    throw e;
  }
  return toNoticeFilePublic(row);
}

export async function abortNoticeFileUpload(
  db: PrismaClient,
  input: {
    noticeId: number;
    grant: string;
    auth: ResolvedAuthUser;
  }
): Promise<{ ok: true; registered: boolean }> {
  await requireWritableNotice(db, input.noticeId, input.auth);
  const grant = parseSignedNoticeFileGrant(input.grant);
  if (grant.noticeId !== input.noticeId || grant.actor !== noticeFileActorKey(input.auth)) {
    throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
  }
  return db.$transaction(async (tx) => {
    await lockNoticeFileStorageKey(tx, grant.storageKey);
    const existing = await findExistingByStorageKey(tx, grant.storageKey, input.noticeId);
    if (existing) {
      if (existing.noticeId !== input.noticeId) {
        throw new NoticeFileValidationError("forbidden", "첨부파일을 올릴 수 없습니다.", 403);
      }
      return { ok: true as const, registered: true };
    }
    await cleanupNoticeFileBlobsBestEffort([grant.storageKey], {
      noticeId: input.noticeId,
    });
    return { ok: true as const, registered: false };
  }, NOTICE_FILE_TX_OPTS);
}

export async function putLocalNoticeFileBytes(input: {
  storageKey: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<void> {
  const parsed = parseNoticeFileStorageKey(input.storageKey);
  if (!parsed) {
    throw new NoticeFileValidationError("unauthorized", "업로드 권한이 없습니다.", 401);
  }
  if (NOTICE_FILE_MIME_BY_EXT[parsed.ext] !== input.contentType) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage());
  }
  const store = requireConfiguredStore();
  try {
    await store.put(input.storageKey, input.bytes, input.contentType);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError(
      "storage_put_failed",
      "첨부파일 저장에 실패했습니다.",
      502
    );
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
  await requireWritableNotice(db, input.noticeId, input.auth);
  const store = requireConfiguredStore();
  const claimed = noticeFileExtFromName(input.originalName);
  const kind = assertNoticeFileBytes(input.bytes, claimed);
  const originalName = sanitizeNoticeFileName(input.originalName, kind.ext);
  const storageKey = buildNoticeFileStorageKey(input.noticeId, kind.ext);
  try {
    await store.put(storageKey, input.bytes, kind.mime);
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
          mimeType: kind.mime,
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
  const ext = noticeFileExtFromMime(file.mimeType) ?? noticeFileExtFromName(file.originalName);
  if (!ext || NOTICE_FILE_MIME_BY_EXT[ext] !== file.mimeType) {
    throw new NoticeFileValidationError("unsupported_type", noticeFileTypeMessage(), 415);
  }
  return file;
}

export async function openNoticeFileBody(storageKey: string, abortSignal?: AbortSignal) {
  const store = requireConfiguredStore();
  const opts = abortSignal ? { abortSignal } : undefined;
  const body = store.open
    ? await store.open(storageKey, opts)
    : await store.get(storageKey, opts);
  if (!body) {
    throw new NoticeFileValidationError("not_found", "첨부파일을 찾을 수 없습니다.", 404);
  }
  return body;
}

export const NOTICE_FILE_UPLOAD_TTL_MS = NOTICE_FILE_SIGNED_PUT_TTL_MS;
