/**
 * 자유게시판 사진 (server-only). 기존 private object storage 어댑터를 재사용하되
 * storage key 는 전용 prefix `free-board/<postId>/<uuid>.<ext>` 로 분리한다.
 * 기존 notices/ · course-reports/ 객체는 읽거나 지우지 않는다.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type FreeBoardPhoto, type FreeBoardPost, type PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import {
  COURSE_REPORT_PHOTO_EXT,
  type CourseReportPhotoMime,
} from "@/lib/courseReportPhotoConstants";
import {
  CourseReportPhotoValidationError,
  assertCourseReportPhotoBytes,
} from "@/lib/courseReportPhotoMagic";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import { FREE_BOARD_KEY_RE, getFreeBoardPhotoStore } from "@/lib/freeBoardPhotoStorage";
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
  return (
    key.startsWith(`${FREE_BOARD_STORAGE_PREFIX}/`) && !key.includes("..") && FREE_BOARD_KEY_RE.test(key)
  );
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

function requireStore() {
  const r = getFreeBoardPhotoStore();
  if (!r.ok) throw new CourseReportPhotoStorageError(r.code, r.message, 503);
  return r.store;
}

export type OrphanLogger = (info: { postId: number | null; photoId: number | null; reason: string }) => void;

/** 정리 실패 객체는 orphan 으로 기록 (storage key/값은 로그에 남기지 않음 — postId/photoId 로 추적). */
let orphanLogger: OrphanLogger = (info) => {
  console.error("[free-board-orphan] blob cleanup failed", info);
};
export function setFreeBoardOrphanLoggerForTests(fn: OrphanLogger | null) {
  orphanLogger =
    fn ??
    ((info) => {
      console.error("[free-board-orphan] blob cleanup failed", info);
    });
}

/**
 * DB commit 이후에만 호출. 객체 삭제는 best-effort, 키마다 최대 attempts 회 재시도.
 * 실패한 수를 반환하고 orphan 으로 기록한다 (DB 는 이미 일관된 상태).
 */
export async function deleteFreeBoardObjectsBestEffort(
  items: { storageKey: string; postId?: number; photoId?: number }[],
  attempts = 2
): Promise<number> {
  if (items.length === 0) return 0;
  const r = getFreeBoardPhotoStore();
  if (!r.ok) {
    for (const it of items) orphanLogger({ postId: it.postId ?? null, photoId: it.photoId ?? null, reason: r.code });
    return items.length;
  }
  let failed = 0;
  for (const it of items) {
    if (!isFreeBoardStorageKey(it.storageKey)) continue;
    let done = false;
    for (let i = 0; i < attempts && !done; i++) {
      try {
        await r.store.delete(it.storageKey);
        done = true;
      } catch {
        /* retry */
      }
    }
    if (!done) {
      failed += 1;
      orphanLogger({ postId: it.postId ?? null, photoId: it.photoId ?? null, reason: "delete_failed" });
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
  // 저장소 격리 정책 먼저 (Preview 전용 저장소 없으면 503, 공용 fallback 없음)
  const store = requireStore();
  // 빠른 사전 거부 (최종 판정은 아래 트랜잭션의 행 잠금 안에서)
  const pre = await db.freeBoardPhoto.count({ where: { postId: input.postId } });
  if (pre >= FREE_BOARD_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError("photo_limit", LIMIT_MESSAGE, 409);
  }
  const mime = assertCourseReportPhotoBytes(input.bytes);
  const storageKey = buildFreeBoardPhotoStorageKey(input.postId, mime);
  try {
    await store.put(storageKey, input.bytes, mime);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError("storage_put_failed", "사진 저장에 실패했습니다.", 502);
  }
  let row: FreeBoardPhoto;
  try {
    row = await db.$transaction(async (tx) => {
      // 게시글 행 잠금 → 같은 게시글의 동시 업로드는 직렬화되어 9장 제한이 깨지지 않는다.
      const locked = await tx.$queryRaw<{ id: number }[]>(
        Prisma.sql`SELECT "id" FROM "FreeBoardPost" WHERE "id" = ${input.postId} AND "deletedAt" IS NULL FOR UPDATE`
      );
      if (locked.length === 0) {
        throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
      }
      const count = await tx.freeBoardPhoto.count({ where: { postId: input.postId } });
      if (count >= FREE_BOARD_PHOTO_MAX) {
        throw new CourseReportPhotoValidationError("photo_limit", LIMIT_MESSAGE, 409);
      }
      const last = await tx.freeBoardPhoto.aggregate({
        where: { postId: input.postId },
        _max: { sortOrder: true },
      });
      return tx.freeBoardPhoto.create({
        data: {
          postId: input.postId,
          storageKey,
          mimeType: mime,
          size: input.bytes.byteLength,
          sortOrder: (last._max.sortOrder ?? -1) + 1,
        },
      });
    });
  } catch (e) {
    // DB 반영 실패/한도 초과 → 방금 올린 객체 정리 (orphan 방지)
    await deleteFreeBoardObjectsBestEffort([{ storageKey, postId: input.postId }]);
    throw e;
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
  const failed = await deleteFreeBoardObjectsBestEffort([
    { storageKey: photo.storageKey, postId: input.postId, photoId: photo.id },
  ]);
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
  await deleteFreeBoardObjectsBestEffort(
    rows.map((r) => ({ storageKey: r.storageKey, postId, photoId: r.id }))
  );
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
  const store = requireStore();
  const opts = abortSignal ? { abortSignal } : undefined;
  const body = store.open ? await store.open(storageKey, opts) : await store.get(storageKey, opts);
  if (!body) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return body;
}

/** removedPhotoIds 파싱: 정수 배열, 중복 제거, 최대 9개. */
export function parseRemovedPhotoIds(input: unknown): number[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new CourseReportPhotoValidationError("invalid_removed_photos", "삭제할 사진 목록이 올바르지 않습니다.", 400);
  }
  const ids = Array.from(new Set(input.map((v) => Number(v))));
  if (ids.length > FREE_BOARD_PHOTO_MAX || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new CourseReportPhotoValidationError("invalid_removed_photos", "삭제할 사진 목록이 올바르지 않습니다.", 400);
  }
  return ids;
}

/**
 * 글 수정 최종 저장: 본문 수정 + 사진 삭제를 하나의 DB 트랜잭션으로 반영.
 * - removedPhotoIds 중 하나라도 이 게시글 소속이 아니면 전체 거부 (404), 아무것도 바뀌지 않음.
 * - DB 실패 → 롤백, 객체 삭제 안 함.
 * - DB 성공 후 객체 삭제는 best-effort(재시도), 실패분은 orphan 기록. 사용자 응답은 성공.
 */
export async function saveFreeBoardPostEdit(
  db: PrismaClient,
  input: { postId: number; title: string; body: string; removedPhotoIds: number[] }
): Promise<{ post: FreeBoardPost; removed: number; blobCleanupFailed: number }> {
  const { post, removed } = await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<{ id: number }[]>(
      Prisma.sql`SELECT "id" FROM "FreeBoardPost" WHERE "id" = ${input.postId} AND "deletedAt" IS NULL FOR UPDATE`
    );
    if (locked.length === 0) {
      throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
    }
    let removed: FreeBoardPhoto[] = [];
    if (input.removedPhotoIds.length) {
      removed = await tx.freeBoardPhoto.findMany({
        where: { id: { in: input.removedPhotoIds }, postId: input.postId },
      });
      if (removed.length !== input.removedPhotoIds.length) {
        throw new CourseReportPhotoValidationError("photo_not_found", "사진을 찾을 수 없습니다.", 404);
      }
      await tx.freeBoardPhoto.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
    }
    const post = await tx.freeBoardPost.update({
      where: { id: input.postId },
      data: { title: input.title, body: input.body },
    });
    return { post, removed };
  });
  const blobCleanupFailed = await deleteFreeBoardObjectsBestEffort(
    removed.map((r) => ({ storageKey: r.storageKey, postId: input.postId, photoId: r.id }))
  );
  return { post, removed: removed.length, blobCleanupFailed };
}
