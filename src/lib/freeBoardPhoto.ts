/**
 * 자유게시판 사진 (server-only). 기존 private object storage 어댑터를 재사용하되
 * storage key 는 전용 prefix `free-board/<postId>/<uuid>.<ext>` 로 분리한다.
 * 기존 notices/ · course-reports/ 객체는 읽거나 지우지 않는다.
 */
import { randomUUID } from "node:crypto";
import type { FreeBoardPhoto, PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
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
  FREE_BOARD_PHOTO_MAX,
  FREE_BOARD_PHOTO_MAX_BYTES,
  FREE_BOARD_STORAGE_PREFIX,
  type FreeBoardPhotoPublic,
} from "@/lib/freeBoardConstants";
import { canEditFreeBoardPost, canDeleteFreeBoardPost } from "@/lib/freeBoard";

export { CourseReportPhotoValidationError as FreeBoardPhotoValidationError };
export { CourseReportPhotoStorageError as FreeBoardPhotoStorageError };

const LIMIT_MESSAGE = `사진은 최대 ${FREE_BOARD_PHOTO_MAX}장까지 첨부할 수 있습니다.`;

export function buildFreeBoardPhotoStorageKey(
  postId: number,
  mime: CourseReportPhotoMime,
  id = randomUUID()
): string {
  return `${FREE_BOARD_STORAGE_PREFIX}/${postId}/${id}.${COURSE_REPORT_PHOTO_EXT[mime]}`;
}

/** 이 모듈이 다루는 key 는 반드시 free-board/ prefix. 다른 기능 객체 삭제 방지. */
export function isFreeBoardStorageKey(key: string): boolean {
  return key.startsWith(`${FREE_BOARD_STORAGE_PREFIX}/`) && !key.includes("..");
}

export function toFreeBoardPhotoPublic(row: FreeBoardPhoto): FreeBoardPhotoPublic {
  return {
    id: row.id,
    mimeType: row.mimeType,
    size: row.size,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listFreeBoardPhotos(
  db: PrismaClient,
  postId: number
): Promise<FreeBoardPhotoPublic[]> {
  const rows = await db.freeBoardPhoto.findMany({
    where: { postId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return rows.map(toFreeBoardPhotoPublic);
}

async function deleteObjectsBestEffort(keys: string[]): Promise<number> {
  const store = getCourseReportPhotoStore();
  if (!store.configured) return 0;
  let failed = 0;
  for (const key of keys) {
    if (!isFreeBoardStorageKey(key)) continue;
    try {
      await store.delete(key);
    } catch {
      failed += 1;
      console.error("[free-board-photo] object cleanup failed");
    }
  }
  return failed;
}

/** 업로드: 게시글 작성자 본인만. 9장 초과 409, 형식(magic bytes) 검증, 크기 제한. */
export async function uploadFreeBoardPhoto(
  db: PrismaClient,
  input: { postId: number; bytes: Uint8Array; auth: ResolvedAuthUser }
): Promise<FreeBoardPhotoPublic> {
  const post = await db.freeBoardPost.findFirst({
    where: { id: input.postId, deletedAt: null },
  });
  if (!post) {
    throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  }
  if (
    !canEditFreeBoardPost({
      userId: input.auth.userId,
      authorUserId: post.authorUserId,
      deletedAt: post.deletedAt,
    })
  ) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }
  if (input.bytes.byteLength === 0) {
    throw new CourseReportPhotoValidationError("empty_file", "사진 파일이 필요합니다.");
  }
  if (input.bytes.byteLength > FREE_BOARD_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoValidationError(
      "file_too_large",
      "사진 용량이 너무 큽니다.",
      413
    );
  }
  const existing = await db.freeBoardPhoto.count({ where: { postId: input.postId } });
  if (existing >= FREE_BOARD_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError("photo_limit", LIMIT_MESSAGE, 409);
  }
  const mime = assertCourseReportPhotoBytes(input.bytes);
  const store = getCourseReportPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const storageKey = buildFreeBoardPhotoStorageKey(input.postId, mime);
  try {
    await store.put(storageKey, input.bytes, mime);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError("storage_put_failed", "사진 저장에 실패했습니다.", 502);
  }
  let row: FreeBoardPhoto;
  try {
    row = await db.freeBoardPhoto.create({
      data: {
        postId: input.postId,
        storageKey,
        mimeType: mime,
        size: input.bytes.byteLength,
        sortOrder: existing,
      },
    });
  } catch (e) {
    await deleteObjectsBestEffort([storageKey]);
    throw e;
  }
  // 동시 업로드 경합 보정: 9장 초과 시 방금 올린 사진 롤백.
  const after = await db.freeBoardPhoto.count({ where: { postId: input.postId } });
  if (after > FREE_BOARD_PHOTO_MAX) {
    await db.freeBoardPhoto.delete({ where: { id: row.id } }).catch(() => undefined);
    await deleteObjectsBestEffort([storageKey]);
    throw new CourseReportPhotoValidationError("photo_limit", LIMIT_MESSAGE, 409);
  }
  return toFreeBoardPhotoPublic(row);
}

/** 사진 삭제: 작성자 본인 또는 관리자. */
export async function deleteFreeBoardPhoto(
  db: PrismaClient,
  input: { postId: number; photoId: number; auth: ResolvedAuthUser }
): Promise<{ blobCleanupFailed: boolean }> {
  const post = await db.freeBoardPost.findFirst({
    where: { id: input.postId, deletedAt: null },
  });
  if (!post) {
    throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  }
  if (
    !canDeleteFreeBoardPost({
      role: input.auth.role,
      userId: input.auth.userId,
      authorUserId: post.authorUserId,
      deletedAt: post.deletedAt,
    })
  ) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 삭제할 수 없습니다.", 403);
  }
  const photo = await db.freeBoardPhoto.findUnique({ where: { id: input.photoId } });
  if (!photo || photo.postId !== input.postId) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  await db.freeBoardPhoto.delete({ where: { id: photo.id } });
  const failed = await deleteObjectsBestEffort([photo.storageKey]);
  return { blobCleanupFailed: failed > 0 };
}

/** 게시글 soft delete 시 사진 객체 정리 (best effort, DB row 는 게시글과 함께 유지). */
export async function cleanupFreeBoardPostPhotos(
  db: PrismaClient,
  postId: number
): Promise<void> {
  const rows = await db.freeBoardPhoto.findMany({
    where: { postId },
    select: { id: true, storageKey: true },
  });
  if (rows.length === 0) return;
  await db.freeBoardPhoto.deleteMany({ where: { postId } });
  await deleteObjectsBestEffort(rows.map((r) => r.storageKey));
}

export async function loadFreeBoardPhotoMeta(
  db: PrismaClient,
  input: { postId: number; photoId: number }
): Promise<FreeBoardPhoto> {
  const post = await db.freeBoardPost.findFirst({
    where: { id: input.postId, deletedAt: null },
    select: { id: true },
  });
  if (!post) {
    throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  }
  const photo = await db.freeBoardPhoto.findUnique({ where: { id: input.photoId } });
  if (!photo || photo.postId !== input.postId || !isFreeBoardStorageKey(photo.storageKey)) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return photo;
}

export async function openFreeBoardPhotoBody(storageKey: string, abortSignal?: AbortSignal) {
  if (!isFreeBoardStorageKey(storageKey)) {
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
  const opts = abortSignal ? { abortSignal } : undefined;
  const body = store.open ? await store.open(storageKey, opts) : await store.get(storageKey, opts);
  if (!body) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return body;
}
