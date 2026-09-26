import { randomUUID } from "node:crypto";
import { Prisma, type NoticePhoto, type PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import { canWriteInternalNotice } from "@/lib/noticeAccess";
import { canViewNotice } from "@/lib/noticeTarget";
import {
  COURSE_REPORT_PHOTO_EXT,
  type CourseReportPhotoMime,
} from "@/lib/courseReportPhotoConstants";
import {
  CourseReportPhotoValidationError,
  assertCourseReportPhotoBytes,
} from "@/lib/courseReportPhotoMagic";
import {
  CourseReportPhotoStorageError,
  getCourseReportPhotoStore,
} from "@/lib/courseReportPhotoStorage";
import {
  NOTICE_PHOTO_MAX,
  type NoticePhotoPublic,
} from "@/lib/noticePhotoConstants";

export type { NoticePhotoPublic } from "@/lib/noticePhotoConstants";
export { noticePhotoSrc } from "@/lib/noticePhotoConstants";

export function isNoticePhotoTableMissing(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2010")
  ) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /NoticePhoto/i.test(msg) && /does not exist|relation|table/i.test(msg);
}

function photoTableNotReady(): never {
  throw new CourseReportPhotoStorageError(
    "photo_table_not_ready",
    "사진 기능이 아직 준비되지 않았습니다.",
    503
  );
}

export function toNoticePhotoPublic(row: NoticePhoto): NoticePhotoPublic {
  return {
    id: row.id,
    mimeType: row.mimeType,
    size: row.size,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export function canManageNoticePhotos(role: ResolvedAuthUser["role"]): boolean {
  return canWriteInternalNotice(role);
}

export function buildNoticePhotoStorageKey(
  noticeId: number,
  mime: CourseReportPhotoMime,
  id = randomUUID()
): string {
  return `notices/${noticeId}/${id}.${COURSE_REPORT_PHOTO_EXT[mime]}`;
}

export async function listNoticePhotos(
  db: PrismaClient,
  noticeId: number
): Promise<NoticePhotoPublic[]> {
  try {
    const rows = await db.noticePhoto.findMany({
      where: { noticeId },
      orderBy: { sortOrder: "asc" },
    });
    return rows.map(toNoticePhotoPublic);
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) return [];
    throw e;
  }
}

export async function countNoticePhotos(
  db: PrismaClient,
  noticeId: number
): Promise<number> {
  try {
    return await db.noticePhoto.count({ where: { noticeId } });
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) return 0;
    throw e;
  }
}

export async function uploadNoticePhoto(
  db: PrismaClient,
  input: {
    noticeId: number;
    bytes: Uint8Array;
    auth: ResolvedAuthUser;
  }
): Promise<NoticePhotoPublic> {
  if (!canManageNoticePhotos(input.auth.role)) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }

  const notice = await db.notice.findUnique({ where: { id: input.noticeId } });
  if (!notice) {
    throw new CourseReportPhotoValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }

  let existing: number;
  try {
    existing = await db.noticePhoto.count({ where: { noticeId: input.noticeId } });
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) photoTableNotReady();
    throw e;
  }
  if (existing >= NOTICE_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }

  const mime = assertCourseReportPhotoBytes(input.bytes);
  const storageKey = buildNoticePhotoStorageKey(input.noticeId, mime);
  try {
    await store.put(storageKey, input.bytes, mime);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError(
      "storage_put_failed",
      "사진 저장에 실패했습니다.",
      502
    );
  }

  let row: NoticePhoto;
  try {
    row = await db.noticePhoto.create({
      data: {
        noticeId: input.noticeId,
        storageKey,
        mimeType: mime,
        size: input.bytes.byteLength,
        sortOrder: existing,
      },
    });
  } catch (e) {
    await store.delete(storageKey).catch(() => undefined);
    if (isNoticePhotoTableMissing(e)) photoTableNotReady();
    throw e;
  }

  const after = await db.noticePhoto.count({ where: { noticeId: input.noticeId } });
  if (after > NOTICE_PHOTO_MAX) {
    await db.noticePhoto.delete({ where: { id: row.id } }).catch(() => undefined);
    await store.delete(storageKey).catch(() => undefined);
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }
  return toNoticePhotoPublic(row);
}

export async function listNoticePhotoStorageKeys(
  db: PrismaClient,
  noticeId: number
): Promise<string[]> {
  try {
    const rows = await db.noticePhoto.findMany({
      where: { noticeId },
      select: { storageKey: true },
    });
    return rows.map((row) => row.storageKey);
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) return [];
    throw e;
  }
}

export async function cleanupNoticePhotoBlobsBestEffort(
  keys: string[],
  context?: { noticeId?: number; photoId?: number }
): Promise<{ failed: string[] }> {
  const store = getCourseReportPhotoStore();
  if (!store.configured) return { failed: [] };
  const failed: string[] = [];
  for (const storageKey of keys) {
    try {
      await store.delete(storageKey);
    } catch (e) {
      failed.push(storageKey);
      console.error("[notice-photo] orphan blob cleanup failed", {
        noticeId: context?.noticeId ?? null,
        photoId: context?.photoId ?? null,
        storageKey,
        error: e instanceof Error ? e.message : String(e ?? ""),
      });
    }
  }
  return { failed };
}

export async function deleteNoticePhoto(
  db: PrismaClient,
  input: {
    noticeId: number;
    photoId: number;
    auth: ResolvedAuthUser;
  }
): Promise<{ blobCleanupFailed: boolean }> {
  if (!canManageNoticePhotos(input.auth.role)) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 삭제할 수 없습니다.", 403);
  }
  const notice = await db.notice.findUnique({ where: { id: input.noticeId } });
  if (!notice) {
    throw new CourseReportPhotoValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }

  let photo: NoticePhoto | null;
  try {
    photo = await db.noticePhoto.findUnique({ where: { id: input.photoId } });
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) photoTableNotReady();
    throw e;
  }
  if (!photo || photo.noticeId !== input.noticeId) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }

  try {
    await db.noticePhoto.delete({ where: { id: photo.id } });
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) photoTableNotReady();
    throw e;
  }

  const cleanup = await cleanupNoticePhotoBlobsBestEffort([photo.storageKey], {
    noticeId: input.noticeId,
    photoId: input.photoId,
  });
  return { blobCleanupFailed: cleanup.failed.length > 0 };
}

export async function loadNoticePhotoBytes(
  db: PrismaClient,
  input: {
    noticeId: number;
    photoId: number;
    viewer: Parameters<typeof canViewNotice>[1];
  }
): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const notice = await db.notice.findUnique({ where: { id: input.noticeId } });
  if (!notice || !canViewNotice(notice, input.viewer)) {
    throw new CourseReportPhotoValidationError("not_found", "공지를 찾을 수 없습니다.", 404);
  }
  let photo: NoticePhoto | null;
  try {
    photo = await db.noticePhoto.findUnique({ where: { id: input.photoId } });
  } catch (e) {
    if (isNoticePhotoTableMissing(e)) photoTableNotReady();
    throw e;
  }
  if (!photo || photo.noticeId !== input.noticeId) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const bytes = await store.get(photo.storageKey);
  if (!bytes) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return { mimeType: photo.mimeType, bytes };
}
