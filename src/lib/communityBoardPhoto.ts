/**
 * 커뮤니티 자유게시판 사진 (server-only).
 * - 기존 private object storage 와 격리 정책을 재사용 (getIsolatedBoardPhotoStore).
 * - key 는 community/free/<postId>/<uuid>.<ext> 만 허용 (가배치표 free-board/, 공지·코스제보 key 접근 불가).
 * - DB 는 CommunityPhoto 만 사용 (가배치표 FreeBoardPhoto 와 분리) → 다른 게시판 사진 id 로 조회·삭제 불가.
 * - 형식(magic bytes)·용량(3MB)·장수(9장)는 서버에서 강제.
 */
import { randomUUID } from "node:crypto";
import { Prisma, type CommunityPhoto, type CommunityPost, type PrismaClient } from "@prisma/client";
import type { ResolvedAuthUser } from "@/lib/auth";
import { COURSE_REPORT_PHOTO_EXT, type CourseReportPhotoMime } from "@/lib/courseReportPhotoConstants";
import { CourseReportPhotoValidationError, assertCourseReportPhotoBytes } from "@/lib/courseReportPhotoMagic";
import {
  CourseReportPhotoStorageError,
  type CourseReportPhotoStore,
  type PhotoOpenOptions,
} from "@/lib/courseReportPhotoStorage";
import { getIsolatedBoardPhotoStore } from "@/lib/freeBoardPhotoStorage";
import {
  COMMUNITY_PHOTO_MAX,
  COMMUNITY_PHOTO_MAX_BYTES,
  COMMUNITY_STORAGE_PREFIX,
  type CommunityPhotoPublic,
} from "@/lib/communityBoardConstants";
import { COMMUNITY_FREE_BOARD_TYPE, canEditCommunityPost } from "@/lib/communityBoard";

export { CourseReportPhotoValidationError as CommunityPhotoValidationError };
export { CourseReportPhotoStorageError as CommunityPhotoStorageError };

const LIMIT_MESSAGE = `사진은 최대 ${COMMUNITY_PHOTO_MAX}장까지 첨부할 수 있습니다.`;

/** 자유게시판 key 형식: community/free/<postId>/<uuid>.<ext> 만. */
export const COMMUNITY_KEY_RE =
  /^community\/free\/[1-9][0-9]{0,9}\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\.(jpg|png|webp)$/;

export function isCommunityStorageKey(key: string): boolean {
  return typeof key === "string" && !key.includes("..") && COMMUNITY_KEY_RE.test(key);
}

/** key 의 postId 가 실제 게시글과 같을 때만 true (다른 글 객체 접근 방지). */
export function communityKeyBelongsToPost(key: string, postId: number): boolean {
  return isCommunityStorageKey(key) && key.startsWith(`${COMMUNITY_STORAGE_PREFIX}/${postId}/`);
}

function assertKey(key: string) {
  if (!isCommunityStorageKey(key)) throw new Error("community_key_rejected");
}

/** 모든 store 호출을 community/free/<postId>/ key 로 제한하는 래퍼. */
export function guardCommunityStore(inner: CourseReportPhotoStore): CourseReportPhotoStore {
  return {
    configured: inner.configured,
    async put(key, bytes, mime) {
      assertKey(key);
      return inner.put(key, bytes, mime);
    },
    async get(key, opts) {
      assertKey(key);
      return inner.get(key, opts);
    },
    ...(inner.open
      ? {
          async open(key: string, opts?: PhotoOpenOptions) {
            assertKey(key);
            return inner.open!(key, opts);
          },
        }
      : {}),
    async delete(key) {
      assertKey(key);
      return inner.delete(key);
    },
    async head(key) {
      assertKey(key);
      return inner.head(key);
    },
    async readPrefix(key, n) {
      assertKey(key);
      return inner.readPrefix(key, n);
    },
  };
}

export function getCommunityPhotoStore() {
  return getIsolatedBoardPhotoStore(guardCommunityStore);
}

function requireStore() {
  const r = getCommunityPhotoStore();
  if (!r.ok) throw new CourseReportPhotoStorageError(r.code, r.message, 503);
  return r.store;
}

export function buildCommunityPhotoStorageKey(
  postId: number,
  mime: CourseReportPhotoMime,
  id: string = randomUUID()
): string {
  return `${COMMUNITY_STORAGE_PREFIX}/${postId}/${id}.${COURSE_REPORT_PHOTO_EXT[mime]}`;
}

const UPLOAD_KEY_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export function normalizeCommunityUploadKey(v: unknown): string | null {
  if (typeof v !== "string") return null;
  const k = v.trim().toLowerCase();
  return UPLOAD_KEY_RE.test(k) ? k : null;
}

async function findByUploadKey(db: Pick<PrismaClient, "communityPhoto">, postId: number, uploadKey: string) {
  return db.communityPhoto.findFirst({
    where: { postId, storageKey: { startsWith: `${COMMUNITY_STORAGE_PREFIX}/${postId}/${uploadKey}.` } },
  });
}

export function toCommunityPhotoPublic(row: CommunityPhoto): CommunityPhotoPublic {
  return {
    id: row.id,
    mimeType: row.mimeType,
    size: row.size,
    sortOrder: row.sortOrder,
    createdAt: row.createdAt.toISOString(),
  };
}

export async function listCommunityPhotos(db: PrismaClient, postId: number): Promise<CommunityPhotoPublic[]> {
  const rows = await db.communityPhoto.findMany({
    where: { postId },
    orderBy: [{ sortOrder: "asc" }, { id: "asc" }],
  });
  return rows.map(toCommunityPhotoPublic);
}

type OrphanLogger = (info: { postId: number | null; photoId: number | null; reason: string }) => void;
const defaultOrphanLogger: OrphanLogger = (info) => {
  console.error("[community-orphan] blob cleanup failed", info);
};
let orphanLogger: OrphanLogger = defaultOrphanLogger;
export function setCommunityOrphanLoggerForTests(fn: OrphanLogger | null) {
  orphanLogger = fn ?? defaultOrphanLogger;
}

/** DB commit 이후에만 호출. 객체 삭제 best-effort (key 는 로그에 남기지 않음). */
export async function deleteCommunityObjectsBestEffort(
  items: { storageKey: string; postId?: number; photoId?: number }[],
  attempts = 2
): Promise<number> {
  if (items.length === 0) return 0;
  const r = getCommunityPhotoStore();
  if (!r.ok) {
    for (const it of items) orphanLogger({ postId: it.postId ?? null, photoId: it.photoId ?? null, reason: r.code });
    return items.length;
  }
  let failed = 0;
  for (const it of items) {
    if (!isCommunityStorageKey(it.storageKey)) continue;
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

async function lockLivePost(tx: Prisma.TransactionClient, postId: number) {
  const locked = await tx.$queryRaw<{ id: number }[]>(
    Prisma.sql`SELECT "id" FROM "CommunityPost" WHERE "id" = ${postId} AND "deletedAt" IS NULL AND "boardType" = 'FREE' FOR UPDATE`
  );
  if (locked.length === 0) {
    throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  }
}

/** 업로드: 게시글 작성자 본인만. 9장 초과 409, magic bytes 형식 검증, 3MB 제한. */
export async function uploadCommunityPhoto(
  db: PrismaClient,
  input: { postId: number; bytes: Uint8Array; auth: ResolvedAuthUser; uploadKey?: string | null }
): Promise<CommunityPhotoPublic & { duplicate?: boolean }> {
  const post = await db.communityPost.findFirst({
    where: { id: input.postId, boardType: COMMUNITY_FREE_BOARD_TYPE, deletedAt: null },
  });
  if (!post) throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  if (
    !canEditCommunityPost({
      role: input.auth.role,
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
  if (input.bytes.byteLength > COMMUNITY_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoValidationError("file_too_large", "사진 용량이 너무 큽니다.", 413);
  }
  const mime = assertCourseReportPhotoBytes(input.bytes);
  const store = requireStore();
  const uploadKey = normalizeCommunityUploadKey(input.uploadKey);
  if (uploadKey) {
    const hit = await findByUploadKey(db, input.postId, uploadKey);
    if (hit) return { ...toCommunityPhotoPublic(hit), duplicate: true };
  }
  const pre = await db.communityPhoto.count({ where: { postId: input.postId } });
  if (pre >= COMMUNITY_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError("photo_limit", LIMIT_MESSAGE, 409);
  }
  const storageKey = buildCommunityPhotoStorageKey(input.postId, mime, uploadKey ?? undefined);
  try {
    await store.put(storageKey, input.bytes, mime);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError("storage_put_failed", "사진 저장에 실패했습니다.", 502);
  }
  let duplicate = false;
  let row: CommunityPhoto;
  try {
    row = await db.$transaction(async (tx) => {
      // 게시글 행 잠금 → 같은 글의 동시 업로드도 9장 제한을 넘지 않는다.
      await lockLivePost(tx, input.postId);
      if (uploadKey) {
        const again = await findByUploadKey(tx, input.postId, uploadKey);
        if (again) {
          duplicate = true;
          return again;
        }
      }
      const count = await tx.communityPhoto.count({ where: { postId: input.postId } });
      if (count >= COMMUNITY_PHOTO_MAX) {
        throw new CourseReportPhotoValidationError("photo_limit", LIMIT_MESSAGE, 409);
      }
      const last = await tx.communityPhoto.aggregate({ where: { postId: input.postId }, _max: { sortOrder: true } });
      return tx.communityPhoto.create({
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
    const owned = uploadKey ? await findByUploadKey(db, input.postId, uploadKey).catch(() => null) : null;
    if (!owned) await deleteCommunityObjectsBestEffort([{ storageKey, postId: input.postId }]);
    throw e;
  }
  return duplicate ? { ...toCommunityPhotoPublic(row), duplicate: true } : toCommunityPhotoPublic(row);
}

/** 사진 메타: 살아있는 자유게시판 글 + 그 글 소속 + key prefix 일치일 때만. */
export async function loadCommunityPhotoMeta(
  db: PrismaClient,
  input: { postId: number; photoId: number }
): Promise<CommunityPhoto> {
  const post = await db.communityPost.findFirst({
    where: { id: input.postId, boardType: COMMUNITY_FREE_BOARD_TYPE, deletedAt: null },
    select: { id: true },
  });
  if (!post) throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  const photo = await db.communityPhoto.findUnique({ where: { id: input.photoId } });
  if (!photo || photo.postId !== input.postId || !communityKeyBelongsToPost(photo.storageKey, input.postId)) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return photo;
}

export async function openCommunityPhotoBody(storageKey: string, abortSignal?: AbortSignal) {
  if (!isCommunityStorageKey(storageKey)) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  const store = requireStore();
  const opts = abortSignal ? { abortSignal } : undefined;
  const body = store.open ? await store.open(storageKey, opts) : await store.get(storageKey, opts);
  if (!body) throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  return body;
}

/** 사진 1장 삭제: 작성자 본인만 (수정 권한과 동일). */
export async function deleteCommunityPhoto(
  db: PrismaClient,
  input: { postId: number; photoId: number; auth: ResolvedAuthUser }
): Promise<{ blobCleanupFailed: boolean }> {
  const post = await db.communityPost.findFirst({
    where: { id: input.postId, boardType: COMMUNITY_FREE_BOARD_TYPE, deletedAt: null },
  });
  if (!post) throw new CourseReportPhotoValidationError("not_found", "게시글을 찾을 수 없습니다.", 404);
  if (
    !canEditCommunityPost({
      role: input.auth.role,
      userId: input.auth.userId,
      authorUserId: post.authorUserId,
      deletedAt: post.deletedAt,
    })
  ) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 삭제할 수 없습니다.", 403);
  }
  const photo = await db.communityPhoto.findUnique({ where: { id: input.photoId } });
  if (!photo || photo.postId !== input.postId) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  await db.communityPhoto.delete({ where: { id: photo.id } });
  const failed = await deleteCommunityObjectsBestEffort([
    { storageKey: photo.storageKey, postId: input.postId, photoId: photo.id },
  ]);
  return { blobCleanupFailed: failed > 0 };
}

/** 게시글 soft delete 후 사진 정리 (best effort). */
export async function cleanupCommunityPostPhotos(db: PrismaClient, postId: number): Promise<void> {
  const rows = await db.communityPhoto.findMany({ where: { postId }, select: { id: true, storageKey: true } });
  if (rows.length === 0) return;
  await db.communityPhoto.deleteMany({ where: { postId } });
  await deleteCommunityObjectsBestEffort(rows.map((r) => ({ storageKey: r.storageKey, postId, photoId: r.id })));
}

/** removedPhotoIds: 정수 배열, 중복 제거, 최대 9개. */
export function parseCommunityRemovedPhotoIds(input: unknown): number[] {
  if (input == null) return [];
  if (!Array.isArray(input)) {
    throw new CourseReportPhotoValidationError("invalid_removed_photos", "삭제할 사진 목록이 올바르지 않습니다.", 400);
  }
  const ids = Array.from(new Set(input.map((v) => Number(v))));
  if (ids.length > COMMUNITY_PHOTO_MAX || ids.some((n) => !Number.isInteger(n) || n <= 0)) {
    throw new CourseReportPhotoValidationError("invalid_removed_photos", "삭제할 사진 목록이 올바르지 않습니다.", 400);
  }
  return ids;
}

/** 글 수정 저장: 본문 + 사진 삭제를 한 트랜잭션으로. 다른 글 사진 id 가 섞이면 전체 거부. */
export async function saveCommunityPostEdit(
  db: PrismaClient,
  input: { postId: number; title: string; body: string; removedPhotoIds: number[] }
): Promise<{ post: CommunityPost; removed: number; blobCleanupFailed: number }> {
  const { post, removed } = await db.$transaction(async (tx) => {
    await lockLivePost(tx, input.postId);
    let removed: CommunityPhoto[] = [];
    if (input.removedPhotoIds.length) {
      removed = await tx.communityPhoto.findMany({ where: { id: { in: input.removedPhotoIds }, postId: input.postId } });
      if (removed.length !== input.removedPhotoIds.length) {
        throw new CourseReportPhotoValidationError("photo_not_found", "사진을 찾을 수 없습니다.", 404);
      }
      await tx.communityPhoto.deleteMany({ where: { id: { in: removed.map((r) => r.id) } } });
    }
    const post = await tx.communityPost.update({
      where: { id: input.postId },
      data: { title: input.title, body: input.body },
    });
    return { post, removed };
  });
  const blobCleanupFailed = await deleteCommunityObjectsBestEffort(
    removed.map((r) => ({ storageKey: r.storageKey, postId: input.postId, photoId: r.id }))
  );
  return { post, removed: removed.length, blobCleanupFailed };
}
