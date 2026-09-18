import { randomUUID } from "node:crypto";
import type { CourseReportPhoto, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import { canEditCourseReportContent } from "@/lib/courseReportAccess";
import {
  COURSE_REPORT_PHOTO_EXT,
  COURSE_REPORT_PHOTO_MAX,
  type CourseReportPhotoMime,
  type CourseReportPhotoPublic,
} from "@/lib/courseReportPhotoConstants";
import {
  CourseReportPhotoValidationError,
  assertCourseReportPhotoBytes,
} from "@/lib/courseReportPhotoMagic";
import {
  CourseReportPhotoStorageError,
  getCourseReportPhotoStore,
} from "@/lib/courseReportPhotoStorage";

export type { CourseReportPhotoPublic } from "@/lib/courseReportPhotoConstants";
export { courseReportPhotoSrc } from "@/lib/courseReportPhotoConstants";

export function toCourseReportPhotoPublic(row: CourseReportPhoto): CourseReportPhotoPublic {
  return {
    id: row.id,
    mimeType: row.mimeType,
    size: row.size,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export function canManageCourseReportPhotos(input: {
  role: ResolvedAuthUser["role"];
  userId: number | null;
  authorUserId: number;
  status: string;
  deletedAt: Date | null;
}): boolean {
  return canEditCourseReportContent(input);
}

export function buildCourseReportPhotoStorageKey(
  reportId: number,
  mime: CourseReportPhotoMime,
  id = randomUUID()
): string {
  return `course-reports/${reportId}/${id}.${COURSE_REPORT_PHOTO_EXT[mime]}`;
}

export async function uploadCourseReportPhoto(
  db: PrismaClient,
  input: {
    reportId: number;
    bytes: Uint8Array;
    auth: ResolvedAuthUser;
  }
): Promise<CourseReportPhotoPublic> {
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }

  const report = await db.courseReport.findUnique({ where: { id: input.reportId } });
  if (!report || report.deletedAt) {
    throw new CourseReportPhotoValidationError("not_found", "제보를 찾을 수 없습니다.", 404);
  }
  if (
    !canManageCourseReportPhotos({
      role: input.auth.role,
      userId: input.auth.userId,
      authorUserId: report.authorUserId,
      status: report.status,
      deletedAt: report.deletedAt,
    })
  ) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }

  const existing = await db.courseReportPhoto.count({ where: { reportId: input.reportId } });
  if (existing >= COURSE_REPORT_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }

  const mime = assertCourseReportPhotoBytes(input.bytes);
  const storageKey = buildCourseReportPhotoStorageKey(input.reportId, mime);
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

  let row: CourseReportPhoto;
  try {
    row = await db.courseReportPhoto.create({
      data: {
        reportId: input.reportId,
        storageKey,
        mimeType: mime,
        size: input.bytes.byteLength,
        sortOrder: existing,
      },
    });
  } catch (e) {
    await store.delete(storageKey).catch(() => undefined);
    throw e;
  }

  const after = await db.courseReportPhoto.count({ where: { reportId: input.reportId } });
  if (after > COURSE_REPORT_PHOTO_MAX) {
    await db.courseReportPhoto.delete({ where: { id: row.id } }).catch(() => undefined);
    await store.delete(storageKey).catch(() => undefined);
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }
  return toCourseReportPhotoPublic(row);
}

export async function deleteCourseReportPhoto(
  db: PrismaClient,
  input: {
    reportId: number;
    photoId: number;
    auth: ResolvedAuthUser;
  }
): Promise<void> {
  const report = await db.courseReport.findUnique({ where: { id: input.reportId } });
  if (!report || report.deletedAt) {
    throw new CourseReportPhotoValidationError("not_found", "제보를 찾을 수 없습니다.", 404);
  }
  if (
    !canManageCourseReportPhotos({
      role: input.auth.role,
      userId: input.auth.userId,
      authorUserId: report.authorUserId,
      status: report.status,
      deletedAt: report.deletedAt,
    })
  ) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 삭제할 수 없습니다.", 403);
  }

  const photo = await db.courseReportPhoto.findUnique({ where: { id: input.photoId } });
  if (!photo || photo.reportId !== input.reportId) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }

  const store = getCourseReportPhotoStore();
  if (store.configured) {
    try {
      await store.delete(photo.storageKey);
    } catch (e) {
      if (e instanceof CourseReportPhotoStorageError) throw e;
      throw new CourseReportPhotoStorageError(
        "storage_delete_failed",
        "사진 저장소 삭제에 실패했습니다.",
        502
      );
    }
  }

  await db.courseReportPhoto.delete({ where: { id: photo.id } });
}

export async function loadCourseReportPhotoBytes(
  db: PrismaClient,
  input: { reportId: number; photoId: number }
): Promise<{ mimeType: string; bytes: Uint8Array }> {
  const report = await db.courseReport.findFirst({
    where: { id: input.reportId, deletedAt: null },
  });
  if (!report) {
    throw new CourseReportPhotoValidationError("not_found", "제보를 찾을 수 없습니다.", 404);
  }
  const photo = await db.courseReportPhoto.findUnique({ where: { id: input.photoId } });
  if (!photo || photo.reportId !== input.reportId) {
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
