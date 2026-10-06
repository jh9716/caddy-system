import { randomUUID } from "node:crypto";
import { Prisma, type ChatAttachment, type PrismaClient } from "@prisma/client";
import {
  CHAT_ATTACHMENT_CLAIM_TTL_SEC,
  signChatAttachmentClaim,
} from "../../cloudflare/verthill-chat/src/protocol";
import { getChatAuthSecret } from "@/lib/chatToken";
import {
  CHAT_PHOTO_CLEANUP_BATCH,
  CHAT_PHOTO_MAX,
  CHAT_PHOTO_MAX_BYTES,
  CHAT_PHOTO_ORPHAN_MS,
  CHAT_PHOTO_PENDING_ORPHAN_MS,
  CHAT_PHOTO_SIGNED_PUT_TTL_MS,
  chatPhotoSrc,
} from "@/lib/chatPhotoConstants";
import {
  parseRequestedChatPhotoMime,
  parseRequestedChatPhotoSize,
  signLocalChatPhotoPutUrl,
} from "@/lib/chatPhotoSignedPut";
import { CHAT_ATTACHMENT_ID_RE } from "../../cloudflare/verthill-chat/src/protocol";
import {
  COURSE_REPORT_PHOTO_EXT,
  type CourseReportPhotoMime,
} from "@/lib/courseReportPhotoConstants";
import {
  COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES,
  CourseReportPhotoValidationError,
  assertCourseReportPhotoBytes,
  assertCourseReportPhotoPrefix,
} from "@/lib/courseReportPhotoMagic";
import {
  CourseReportPhotoStorageError,
  createMemoryCourseReportPhotoStore,
  getCourseReportPhotoStore,
  type CourseReportPhotoStore,
} from "@/lib/courseReportPhotoStorage";
import { isLocalDatabaseUrl } from "@/lib/dbSafety";

export { chatPhotoSrc };

type ChatPhotoMemoryGlobal = typeof globalThis & {
  __caddyChatPhotoMemoryStore?: CourseReportPhotoStore;
};

/** Local agent/dev only. Never on Vercel. Never when Blob is configured. */
export function allowLocalChatPhotoMemoryStore(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (env.LOCAL_PHOTO_MEMORY !== "1") return false;
  if (env.VERCEL === "1") return false;
  return isLocalDatabaseUrl(env.DATABASE_URL);
}

function resolveChatPhotoStore(): CourseReportPhotoStore {
  const store = getCourseReportPhotoStore();
  if (store.configured) return store;
  if (!allowLocalChatPhotoMemoryStore()) return store;
  const g = globalThis as ChatPhotoMemoryGlobal;
  if (!g.__caddyChatPhotoMemoryStore) {
    g.__caddyChatPhotoMemoryStore = createMemoryCourseReportPhotoStore();
  }
  return g.__caddyChatPhotoMemoryStore;
}

export type ChatPhotoPublic = {
  id: string;
  mimeType: string;
  size: number;
  createdAt: string;
  exp: number;
  claim: string;
};

export type ChatPhotoPrepareResult = {
  attachmentId: string;
  uploadUrl: string;
  expiresAt: number;
  maxBytes: number;
  contentType: CourseReportPhotoMime;
};

export function isChatAttachmentTableMissing(e: unknown): boolean {
  if (
    e instanceof Prisma.PrismaClientKnownRequestError &&
    (e.code === "P2021" || e.code === "P2010")
  ) {
    return true;
  }
  const msg = e instanceof Error ? e.message : String(e ?? "");
  return /ChatAttachment/i.test(msg) && /does not exist|relation|table/i.test(msg);
}

function photoTableNotReady(): never {
  throw new CourseReportPhotoStorageError(
    "photo_table_not_ready",
    "사진 기능이 아직 준비되지 않았습니다.",
    503
  );
}

export function buildChatPhotoStorageKey(
  roomId: string,
  mime: CourseReportPhotoMime,
  id = randomUUID()
): string {
  return `chat/${roomId}/${id}.${COURSE_REPORT_PHOTO_EXT[mime]}`;
}

async function toPublic(row: ChatAttachment): Promise<ChatPhotoPublic> {
  const exp = Math.floor(Date.now() / 1000) + CHAT_ATTACHMENT_CLAIM_TTL_SEC;
  const claim = await signChatAttachmentClaim(getChatAuthSecret(), {
    roomId: row.roomId,
    attachmentId: row.id,
    senderUserId: row.senderUserId,
    mimeType: row.mimeType,
    size: row.size,
    exp,
  });
  return {
    id: row.id,
    mimeType: row.mimeType,
    size: row.size,
    createdAt: row.createdAt.toISOString(),
    exp,
    claim,
  };
}

export async function uploadChatPhoto(
  db: PrismaClient,
  input: {
    roomId: string;
    senderUserId: number;
    bytes: Uint8Array;
  }
): Promise<ChatPhotoPublic> {
  const store = resolveChatPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  if (!Number.isInteger(input.senderUserId) || input.senderUserId <= 0) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }

  await runChatAttachmentMaintenance(db);

  let pending: number;
  try {
    pending = await countUnconsumedChatPhotos(db, input);
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }
  if (pending >= CHAT_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }

  const mime = assertCourseReportPhotoBytes(input.bytes);
  const id = randomUUID();
  const storageKey = buildChatPhotoStorageKey(input.roomId, mime, id);
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

  let row: ChatAttachment;
  try {
    row = await db.chatAttachment.create({
      data: {
        id,
        roomId: input.roomId,
        senderUserId: input.senderUserId,
        storageKey,
        mimeType: mime,
        size: input.bytes.byteLength,
        uploadState: "READY",
      },
    });
  } catch (e) {
    await store.delete(storageKey).catch(() => undefined);
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }

  const after = await countUnconsumedChatPhotos(db, input);
  if (after > CHAT_PHOTO_MAX) {
    await db.chatAttachment.delete({ where: { id: row.id } }).catch(() => undefined);
    await store.delete(storageKey).catch(() => undefined);
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }
  return toPublic(row);
}

async function countUnconsumedChatPhotos(
  db: PrismaClient,
  input: { roomId: string; senderUserId: number }
): Promise<number> {
  try {
    return await db.chatAttachment.count({
      where: {
        roomId: input.roomId,
        senderUserId: input.senderUserId,
        consumedAt: null,
      },
    });
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }
}

async function deleteChatPhotoIntent(
  db: PrismaClient,
  row: { id: string; storageKey: string }
): Promise<void> {
  await db.chatAttachment.delete({ where: { id: row.id } }).catch(() => undefined);
  const store = resolveChatPhotoStore();
  if (store.configured) {
    await store.delete(row.storageKey).catch(() => undefined);
  }
}

async function issueChatPhotoSignedPutUrl(input: {
  storageKey: string;
  contentType: CourseReportPhotoMime;
}): Promise<{ uploadUrl: string; expiresAt: number }> {
  const store = resolveChatPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const expiresAt = Date.now() + CHAT_PHOTO_SIGNED_PUT_TTL_MS;
  if (store.createSignedPutUrl) {
    const signed = await store.createSignedPutUrl({
      pathname: input.storageKey,
      contentType: input.contentType,
      maximumSizeInBytes: CHAT_PHOTO_MAX_BYTES,
      validUntilMs: expiresAt,
    });
    return { uploadUrl: signed.uploadUrl, expiresAt: signed.expiresAt || expiresAt };
  }
  const secret = getChatAuthSecret();
  if (!secret) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  return {
    uploadUrl: signLocalChatPhotoPutUrl(secret, {
      storageKey: input.storageKey,
      contentType: input.contentType,
      maxBytes: CHAT_PHOTO_MAX_BYTES,
      exp: Math.floor(expiresAt / 1000),
    }),
    expiresAt,
  };
}

export async function prepareChatPhotoUpload(
  db: PrismaClient,
  input: {
    roomId: string;
    senderUserId: number;
    contentType: unknown;
    size: unknown;
  }
): Promise<ChatPhotoPrepareResult> {
  const store = resolveChatPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  if (!Number.isInteger(input.senderUserId) || input.senderUserId <= 0) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }
  const mime = parseRequestedChatPhotoMime(input.contentType);
  parseRequestedChatPhotoSize(input.size);

  await runChatAttachmentMaintenance(db);

  const pending = await countUnconsumedChatPhotos(db, input);
  if (pending >= CHAT_PHOTO_MAX) {
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }

  const id = randomUUID();
  const storageKey = buildChatPhotoStorageKey(input.roomId, mime, id);
  let row: ChatAttachment;
  try {
    row = await db.chatAttachment.create({
      data: {
        id,
        roomId: input.roomId,
        senderUserId: input.senderUserId,
        storageKey,
        mimeType: mime,
        size: 0,
        uploadState: "PENDING",
      },
    });
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }

  const after = await countUnconsumedChatPhotos(db, input);
  if (after > CHAT_PHOTO_MAX) {
    await deleteChatPhotoIntent(db, row);
    throw new CourseReportPhotoValidationError(
      "photo_limit",
      "사진은 최대 3장까지 첨부할 수 있습니다.",
      409
    );
  }

  try {
    const signed = await issueChatPhotoSignedPutUrl({
      storageKey,
      contentType: mime,
    });
    return {
      attachmentId: row.id,
      uploadUrl: signed.uploadUrl,
      expiresAt: signed.expiresAt,
      maxBytes: CHAT_PHOTO_MAX_BYTES,
      contentType: mime,
    };
  } catch (e) {
    await deleteChatPhotoIntent(db, row);
    throw e;
  }
}

export async function finalizeChatPhotoUpload(
  db: PrismaClient,
  input: {
    roomId: string;
    attachmentId: string;
    senderUserId: number;
  }
): Promise<ChatPhotoPublic> {
  const store = resolveChatPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  if (!Number.isInteger(input.senderUserId) || input.senderUserId <= 0) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }

  let row: ChatAttachment | null;
  try {
    row = await db.chatAttachment.findUnique({ where: { id: input.attachmentId } });
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }
  if (!row || row.roomId !== input.roomId) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  if (row.senderUserId !== input.senderUserId) {
    throw new CourseReportPhotoValidationError("forbidden", "사진을 첨부할 수 없습니다.", 403);
  }
  if (row.uploadState === "READY") {
    return toPublic(row);
  }
  if (row.uploadState !== "PENDING") {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }

  let meta: { size: number; contentType: string } | null;
  let prefix: Uint8Array | null;
  try {
    meta = await store.head(row.storageKey);
    if (!meta || meta.size <= 0) {
      await deleteChatPhotoIntent(db, row);
      throw new CourseReportPhotoValidationError(
        "upload_incomplete",
        "사진 업로드가 완료되지 않았습니다.",
        409
      );
    }
    if (meta.size > CHAT_PHOTO_MAX_BYTES) {
      await deleteChatPhotoIntent(db, row);
      throw new CourseReportPhotoValidationError(
        "file_too_large",
        "사진은 장당 3MB 이하만 첨부할 수 있습니다."
      );
    }
    prefix = await store.readPrefix(row.storageKey, COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES);
  } catch (e) {
    if (e instanceof CourseReportPhotoValidationError) throw e;
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError(
      "storage_get_failed",
      "사진 읽기에 실패했습니다.",
      502
    );
  }
  if (!prefix || prefix.byteLength === 0) {
    await deleteChatPhotoIntent(db, row);
    throw new CourseReportPhotoValidationError(
      "upload_incomplete",
      "사진 업로드가 완료되지 않았습니다.",
      409
    );
  }

  let mime: CourseReportPhotoMime;
  try {
    mime = assertCourseReportPhotoPrefix({ prefix, totalSize: meta.size });
  } catch (e) {
    await deleteChatPhotoIntent(db, row);
    throw e;
  }

  let ready: ChatAttachment;
  try {
    ready = await db.chatAttachment.update({
      where: { id: row.id },
      data: {
        uploadState: "READY",
        mimeType: mime,
        size: meta.size,
      },
    });
  } catch (e) {
    await deleteChatPhotoIntent(db, row);
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }
  return toPublic(ready);
}

export async function putLocalChatPhotoBytes(input: {
  storageKey: string;
  contentType: string;
  bytes: Uint8Array;
}): Promise<void> {
  const store = resolveChatPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  if (input.bytes.byteLength > CHAT_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoValidationError(
      "file_too_large",
      "사진은 장당 3MB 이하만 첨부할 수 있습니다."
    );
  }
  try {
    await store.put(input.storageKey, input.bytes, input.contentType);
  } catch (e) {
    if (e instanceof CourseReportPhotoStorageError) throw e;
    throw new CourseReportPhotoStorageError(
      "storage_put_failed",
      "사진 저장에 실패했습니다.",
      502
    );
  }
}

export async function loadChatPhotoMeta(
  db: PrismaClient,
  input: { roomId: string; attachmentId: string }
): Promise<ChatAttachment> {
  let photo: ChatAttachment | null;
  try {
    photo = await db.chatAttachment.findUnique({ where: { id: input.attachmentId } });
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }
  if (!photo || photo.roomId !== input.roomId || photo.uploadState !== "READY") {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return photo;
}

export async function openChatPhotoBody(storageKey: string, abortSignal?: AbortSignal) {
  const store = resolveChatPhotoStore();
  if (!store.configured) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const opts = abortSignal ? { abortSignal } : undefined;
  const body = store.open
    ? await store.open(storageKey, opts)
    : await store.get(storageKey, opts);
  if (!body) {
    throw new CourseReportPhotoValidationError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  return body;
}

export async function consumeChatAttachments(
  db: PrismaClient,
  attachmentIds: string[]
): Promise<number> {
  const ids = [...new Set(attachmentIds.map((id) => String(id || "").trim()).filter(Boolean))];
  if (ids.length === 0) return 0;
  try {
    const result = await db.chatAttachment.updateMany({
      where: { id: { in: ids }, consumedAt: null, uploadState: "READY" },
      data: { consumedAt: new Date() },
    });
    return result.count;
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) return 0;
    throw e;
  }
}

export async function cleanupOrphanChatAttachments(
  db: PrismaClient,
  olderThanMs = CHAT_PHOTO_ORPHAN_MS,
  pendingOlderThanMs = CHAT_PHOTO_PENDING_ORPHAN_MS
): Promise<{ deleted: number; blobFailed: string[] }> {
  const readyCutoff = new Date(Date.now() - olderThanMs);
  const pendingCutoff = new Date(Date.now() - pendingOlderThanMs);
  let rows: Array<{ id: string; storageKey: string }>;
  try {
    rows = await db.chatAttachment.findMany({
      where: {
        OR: [
          { uploadState: "PENDING", createdAt: { lt: pendingCutoff } },
          { uploadState: "READY", consumedAt: null, createdAt: { lt: readyCutoff } },
        ],
      },
      select: { id: true, storageKey: true },
      take: CHAT_PHOTO_CLEANUP_BATCH,
    });
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) return { deleted: 0, blobFailed: [] };
    throw e;
  }
  const store = resolveChatPhotoStore();
  const blobFailed: string[] = [];
  let deleted = 0;
  for (const row of rows) {
    try {
      await db.chatAttachment.delete({ where: { id: row.id } });
      deleted += 1;
    } catch {
      continue;
    }
    if (!store.configured) continue;
    try {
      await store.delete(row.storageKey);
    } catch {
      blobFailed.push(row.storageKey);
      console.error("[chat-photo] orphan blob cleanup failed", {
        attachmentId: row.id,
        storageKey: row.storageKey,
      });
    }
  }
  return { deleted, blobFailed };
}

function uniqueAttachmentIds(raw: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const value of raw) {
    const id = String(value || "").trim();
    if (!CHAT_ATTACHMENT_ID_RE.test(id) || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
    if (out.length >= CHAT_PHOTO_CLEANUP_BATCH) break;
  }
  return out;
}

export type ChatAttachmentPurgeResult = {
  deleted: number;
  skipped: number;
  blobFailed: Array<{ id: string; roomId: string; storageKey: string }>;
};

/** Room-scoped hard delete of attachment rows + best-effort Blob. Never throws. */
export async function purgeChatAttachments(
  db: PrismaClient,
  input: { roomId: string; attachmentIds: string[] }
): Promise<ChatAttachmentPurgeResult> {
  const roomId = String(input.roomId || "").trim();
  const ids = uniqueAttachmentIds(input.attachmentIds || []);
  const empty: ChatAttachmentPurgeResult = { deleted: 0, skipped: 0, blobFailed: [] };
  if (!roomId || ids.length === 0) return empty;
  let rows: Array<{ id: string; roomId: string; storageKey: string }>;
  try {
    rows = await db.chatAttachment.findMany({
      where: { id: { in: ids }, roomId },
      select: { id: true, roomId: true, storageKey: true },
      take: CHAT_PHOTO_CLEANUP_BATCH,
    });
  } catch (e) {
    if (isChatAttachmentTableMissing(e)) return empty;
    console.error("[chat-photo] attachment purge lookup failed", e);
    return empty;
  }
  const store = resolveChatPhotoStore();
  const blobFailed: ChatAttachmentPurgeResult["blobFailed"] = [];
  let deleted = 0;
  for (const row of rows) {
    try {
      await db.chatAttachment.delete({ where: { id: row.id } });
      deleted += 1;
    } catch {
      continue;
    }
    if (!store.configured) continue;
    try {
      await store.delete(row.storageKey);
    } catch {
      blobFailed.push(row);
      console.error("[chat-photo] attachment blob cleanup failed", {
        roomId: row.roomId,
        attachmentId: row.id,
        storageKey: row.storageKey,
      });
    }
  }
  return {
    deleted,
    skipped: ids.length - rows.length,
    blobFailed,
  };
}

/** Best-effort. Must never throw or fail a successful upload/consume. */
export async function runChatAttachmentMaintenance(
  db: PrismaClient
): Promise<{ deleted: number; blobFailed: string[] }> {
  try {
    return await cleanupOrphanChatAttachments(db);
  } catch (e) {
    console.error("[chat-photo] orphan cleanup failed", e);
    return { deleted: 0, blobFailed: [] };
  }
}
