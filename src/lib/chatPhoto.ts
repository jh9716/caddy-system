import { randomUUID } from "node:crypto";
import { Prisma, type ChatAttachment, type PrismaClient } from "@prisma/client";
import {
  CHAT_ATTACHMENT_CLAIM_TTL_SEC,
  signChatAttachmentClaim,
} from "../../cloudflare/verthill-chat/src/protocol";
import { getChatAuthSecret } from "@/lib/chatToken";
import {
  CHAT_PHOTO_MAX,
  CHAT_PHOTO_ORPHAN_MS,
  chatPhotoSrc,
} from "@/lib/chatPhotoConstants";
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
  createMemoryCourseReportPhotoStore,
  getCourseReportPhotoStore,
  type CourseReportPhotoStore,
} from "@/lib/courseReportPhotoStorage";
import { isLocalDatabaseUrl } from "@/lib/dbSafety";

export { chatPhotoSrc };

let localMemoryStore: CourseReportPhotoStore | null = null;

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
  if (!localMemoryStore) localMemoryStore = createMemoryCourseReportPhotoStore();
  return localMemoryStore;
}

export type ChatPhotoPublic = {
  id: string;
  mimeType: string;
  size: number;
  createdAt: string;
  exp: number;
  claim: string;
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

  let pending: number;
  try {
    pending = await db.chatAttachment.count({
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
      },
    });
  } catch (e) {
    await store.delete(storageKey).catch(() => undefined);
    if (isChatAttachmentTableMissing(e)) photoTableNotReady();
    throw e;
  }

  const after = await db.chatAttachment.count({
    where: {
      roomId: input.roomId,
      senderUserId: input.senderUserId,
      consumedAt: null,
    },
  });
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
  if (!photo || photo.roomId !== input.roomId) {
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
      where: { id: { in: ids }, consumedAt: null },
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
  olderThanMs = CHAT_PHOTO_ORPHAN_MS
): Promise<{ deleted: number; blobFailed: string[] }> {
  const cutoff = new Date(Date.now() - olderThanMs);
  let rows: Array<{ id: string; storageKey: string }>;
  try {
    rows = await db.chatAttachment.findMany({
      where: { consumedAt: null, createdAt: { lt: cutoff } },
      select: { id: true, storageKey: true },
      take: 50,
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
    }
  }
  return { deleted, blobFailed };
}
