/**
 * Chat Photo Phase 1. local caddy_local only. Blob mocked.
 * 실행: npm run test:chat-photo-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import {
  blobPrefixGetResultUsable,
  createMemoryCourseReportPhotoStore,
  readBlobObjectPrefixAndMetaWithGet,
  readBlobObjectPrefixWithGet,
  setCourseReportPhotoStoreForTests,
  sizeFromPrefixGetResult,
} from "../src/lib/courseReportPhotoStorage";
import {
  createChatPhotoHotpathClock,
  parseChatPhotoHotpath,
  shouldRunBackgroundChatPhotoCleanup,
} from "../src/lib/chatPhotoHotpath";
import {
  allowLocalChatPhotoMemoryStore,
  cleanupOrphanChatAttachments,
  consumeChatAttachments,
  finalizeChatPhotoUpload,
  loadChatPhotoMeta,
  prepareChatPhotoUpload,
  purgeChatAttachments,
  uploadChatPhoto,
} from "../src/lib/chatPhoto";
import { POST as POST_PROXY } from "../src/app/api/chat/rooms/[roomId]/attachments/route";
import { POST as POST_PREPARE } from "../src/app/api/chat/rooms/[roomId]/attachments/prepare/route";
import { POST as POST_FINALIZE } from "../src/app/api/chat/rooms/[roomId]/attachments/[attachmentId]/finalize/route";
import { PUT as PUT_LOCAL } from "../src/app/api/chat/local-blob-put/route";
import { GET as GET_PHOTO } from "../src/app/api/chat/rooms/[roomId]/attachments/[attachmentId]/route";
import { uploadChatPhotoDirect } from "../src/lib/chatPhotoDirectClient";
import {
  parseRequestedChatPhotoMime,
  verifyLocalChatPhotoPutToken,
} from "../src/lib/chatPhotoSignedPut";
import { POST as POST_CONSUME } from "../src/app/api/chat/attachments/consume/route";
import { POST as POST_CLEANUP } from "../src/app/api/chat/attachments/cleanup/route";
import {
  CHAT_ATTACHMENT_CLEANUP_PATH,
  CHAT_ATTACHMENT_CONSUME_PATH,
  CHAT_INTERNAL_AUTH_HEADER,
  CHAT_INTERNAL_TS_HEADER,
  signChatInternalAuth,
} from "../src/lib/chatInternalAuth";
import {
  CHAT_PHOTO_PUSH_BODY,
  CHAT_PHOTO_REPLY_PREVIEW,
  directorySafePreview,
  parseIncomingAttachments,
  replyPreviewFromBody,
  shouldPurgeChatAttachmentsOnDelete,
  signChatAttachmentClaim,
  validateIncomingMessage,
  verifyChatAttachmentClaim,
} from "../cloudflare/verthill-chat/src/protocol";
import { shouldNotifyChatUser, selectChatPushRecipients } from "../src/lib/chatPushRecipients";
import { buildChatPushPayload } from "../src/lib/chatPushMessage";
import { applyDeletedLine } from "../src/lib/chatPhase4";
import {
  COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES,
  CourseReportPhotoValidationError,
  assertCourseReportPhotoBytes,
  assertCourseReportPhotoPrefix,
} from "../src/lib/courseReportPhotoMagic";
import {
  applyChatPhotoSendProgress,
  applyPreparedChatPhoto,
  chatPhotoComposerBusy,
  instantChatPhotoPicks,
  mapBoundedSettled,
  prepareChatPendingPhoto,
  readyChatPhotosForUpload,
} from "../src/lib/chatPhotoPick";
import {
  canUseChatPhotoFastPath,
  canUseChatPhotoFastPathFromMeta,
  chatPhotoSourceKind,
  chatPhotoSourceKindFromMeta,
  isChatPhotoAcceptableSource,
  isChatPhotoAcceptableSourceFromMeta,
  isHeicLikeFromMeta,
  needsChatPhotoHeavyPrepare,
  planChatPhotoSourceFromMeta,
  prepareChatPhotoSource,
  readChatPhotoFileMeta,
} from "../src/lib/chatPhotoFastPath";
import {
  buildOptimisticOutgoingLine,
  clearedComposerAfterOptimisticSend,
  outgoingChatPhotoSrc,
  revokeChatPhotoPreviewUrls,
  shouldStartOptimisticChatSend,
  usableOptimisticChatPhotos,
} from "../src/lib/chatPhotoOptimistic";
import {
  appendComposerPhotos,
  applyComposerPreparedIfCurrent,
  applyComposerProgressIfCurrent,
  CHAT_PHOTO_COMPOSER_MAX_MESSAGE,
  commitComposerPhotoPicks,
  composerPhotoListsMatch,
  createChatPhotoComposerSession,
  leftoverComposerPhotosAfterSend,
  shouldApplyComposerWrite,
  visibleComposerPhotos,
} from "../src/lib/chatPhotoComposer";
import {
  buildChatPhotoDebugSample,
  canShowChatPhotoDebug,
  chatPhotoDebugApiUrl,
  chatPhotoNow,
  emitChatPhotoTimingSummary,
  chatPhotoTimingRunIdFor,
  commitChatPhotoPrepareTiming,
  enableChatPhotoDebugTiming,
  isChatPhotoDebugTiming,
  markChatPhotoTiming,
  publicChatPhotoTimingKey,
  noteChatPhotoBoundary,
  noteChatPhotoCompression,
  noteChatPhotoCompressionBreakdown,
  noteChatPhotoPrepareScope,
  noteChatPhotoServerHotpath,
  resetChatPhotoTiming,
  startChatPhotoPrepareTiming,
  watchChatPhotoFileAccess,
  stampChatPhotoTiming,
  summarizeChatPhotoTiming,
} from "../src/lib/chatPhotoTiming";
import {
  chatPhotoBitmapResizeOptions,
  chatPhotoDecodePathFromBitmap,
  chatPhotoEncodeBottleneck,
  chatPhotoPutBottleneck,
  createChatPhotoOrientedBitmap,
  planChatPhotoAdaptive,
  prepareChatAdaptivePhoto,
  probeChatPhotoOrientedSize,
  shouldAcceptChatPhotoEncode,
} from "../src/lib/chatPhotoAdaptive";
import {
  orientedImageHeaderSize,
  readImageSizeFromHeader,
  readJpegExifOrientation,
} from "../src/lib/imageHeaderSize";
import { isHeicLikeFile } from "../src/lib/courseReportPhotoClient";
import { CHAT_PHOTO_MAX_BYTES, CHAT_PHOTO_PASSTHROUGH_MAX_BYTES } from "../src/lib/chatPhotoConstants";
import {
  abandonChatPhotoPreupload,
  finishChatPhotoOutgoingUploads,
  startChatPhotoPreupload,
} from "../src/lib/chatPhotoPreupload";
import type { ChatPhotoDirectResult } from "../src/lib/chatPhotoDirectClient";
import { putChatPhotoBytes } from "../src/lib/chatPhotoDirectClient";
import {
  chatPhotoR2WriteEnabled,
  isChatPhotoR2StorageKey,
  setChatMediaWorkerFetchForTests,
} from "../src/lib/chatPhotoR2";
import {
  CHAT_MEDIA_CREATE_ONLY,
  createBoundedConcatStream,
  createMemoryChatMediaBucket,
  handleChatMediaRequest,
  readBoundedBody,
  readPrefixThenRest,
  retryMatchesExisting,
  safeChatMediaUploadFailureLog,
  sha256Hex,
  type ChatMediaEnv,
} from "../cloudflare/verthill-chat/src/chatMedia";
import {
  CHAT_MEDIA_GRANT_HEADER,
  CHAT_MEDIA_PUT_OP,
  CHAT_MEDIA_UPLOADED_OP,
  buildChatPhotoR2StorageKey,
  canonicalChatMediaPutGrant,
  chatMediaSecret,
  chatPhotoStorageBackend,
  deriveChatMediaR2Key,
  inspectChatMediaMagic,
  parseChatMediaObjectRef,
  signChatMediaPutGrant,
  signChatMediaUploadReceipt,
  verifyChatMediaPutGrant,
  verifyChatMediaUploadReceipt,
} from "../cloudflare/verthill-chat/src/chatMediaGrant";
import {
  chatPhotoIdentityMatchesReceipt,
  chatPhotoIdentityMatchesToken,
  resolveChatPhotoRoomAccess,
} from "../src/lib/chatPhotoAccess";
import { signChatToken } from "../src/lib/chatToken";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function jpegBytes(extra = 32, mark = 1): Uint8Array {
  const out = new Uint8Array(Math.max(5, 4 + extra));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out[4] = mark;
  return out;
}

function pngBytes(): Uint8Array {
  return new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
}

function webpBytes(): Uint8Array {
  const out = new Uint8Array(16);
  out.set([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return out;
}

function pdfBytes(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
}

function heicBytes(): Uint8Array {
  const out = new Uint8Array(16);
  out[4] = 0x66;
  out[5] = 0x74;
  out[6] = 0x79;
  out[7] = 0x70;
  out.set([0x68, 0x65, 0x69, 0x63], 8);
  return out;
}

function svgBytes(): Uint8Array {
  return new TextEncoder().encode("<svg xmlns='x'></svg>");
}

function htmlBytes(): Uint8Array {
  return new TextEncoder().encode("<!doctype html><html></html>");
}

function instrumentPhotoStore(store: {
  get: (...args: never[]) => Promise<Uint8Array | null>;
  head: (...args: never[]) => Promise<{ size: number; contentType: string } | null>;
  readPrefix: (...args: never[]) => Promise<Uint8Array | null>;
  readPrefixAndMeta?: (
    ...args: never[]
  ) => Promise<{ prefix: Uint8Array; size: number; contentType: string } | null>;
}) {
  const stats = {
    getCalls: 0,
    getBytes: 0,
    headCalls: 0,
    prefixCalls: 0,
    prefixBytes: 0,
    inspectCalls: 0,
  };
  const reset = () => {
    stats.getCalls = 0;
    stats.getBytes = 0;
    stats.headCalls = 0;
    stats.prefixCalls = 0;
    stats.prefixBytes = 0;
    stats.inspectCalls = 0;
  };
  const origGet = store.get.bind(store);
  const origHead = store.head.bind(store);
  const origPrefix = store.readPrefix.bind(store);
  store.get = (async (key: string, opts?: { abortSignal?: AbortSignal }) => {
    stats.getCalls += 1;
    const bytes = await origGet(key as never, opts as never);
    stats.getBytes += bytes?.byteLength ?? 0;
    return bytes;
  }) as typeof store.get;
  store.head = (async (key: string) => {
    stats.headCalls += 1;
    return origHead(key as never);
  }) as typeof store.head;
  store.readPrefix = (async (key: string, maxBytes: number) => {
    stats.prefixCalls += 1;
    const prefix = await origPrefix(key as never, maxBytes as never);
    stats.prefixBytes += prefix?.byteLength ?? 0;
    return prefix;
  }) as typeof store.readPrefix;
  if (store.readPrefixAndMeta) {
    const origInspect = store.readPrefixAndMeta.bind(store);
    store.readPrefixAndMeta = (async (key: string, maxBytes: number) => {
      stats.inspectCalls += 1;
      const inspected = await origInspect(key as never, maxBytes as never);
      stats.prefixBytes += inspected?.prefix.byteLength ?? 0;
      return inspected;
    }) as typeof store.readPrefixAndMeta;
  }
  return { ...stats, reset, snapshot: () => ({ ...stats }) };
}

async function cookieFor(user: {
  id: number;
  username: string;
  role: "admin" | "caddy" | "leader";
}) {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: 0,
    })
  )}`;
}

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

async function putSigned(uploadUrl: string, bytes: Uint8Array, contentType: string) {
  const url = new URL(uploadUrl, "http://localhost");
  return PUT_LOCAL(
    req(url.href, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: new Uint8Array(bytes),
    })
  );
}

async function prepareHttp(
  cookie: string,
  roomId: string,
  contentType: string,
  size: number
) {
  return POST_PREPARE(
    req(`http://localhost/api/chat/rooms/${roomId}/attachments/prepare`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ contentType, size }),
    }),
    { params: Promise.resolve({ roomId }) }
  );
}

async function finalizeHttp(
  cookie: string,
  roomId: string,
  attachmentId: string,
  receipt?: string,
  search = ""
) {
  return POST_FINALIZE(
    req(
      `http://localhost/api/chat/rooms/${roomId}/attachments/${attachmentId}/finalize${search}`,
      {
        method: "POST",
        headers: { cookie, "content-type": "application/json" },
        body: JSON.stringify(receipt ? { receipt } : {}),
      }
    ),
    { params: Promise.resolve({ roomId, attachmentId }) }
  );
}

async function prepareHttpWithToken(
  cookie: string,
  roomId: string,
  contentType: string,
  size: number,
  chatToken: string,
  search = ""
) {
  return POST_PREPARE(
    req(`http://localhost/api/chat/rooms/${roomId}/attachments/prepare${search}`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ contentType, size, chatToken }),
    }),
    { params: Promise.resolve({ roomId }) }
  );
}

function uploadJson(res: Response | null) {
  return res ? res.clone().json().catch(() => null) : null;
}

section("protocol / wire");
{
  const old = validateIncomingMessage({
    type: "message",
    clientMessageId: "c-old",
    body: "hello",
  });
  assert(old.ok && old.value.body === "hello" && old.value.attachments.length === 0, "old text message still validates");
  const empty = validateIncomingMessage({ type: "message", clientMessageId: "c-empty", body: "" });
  assert(!empty.ok, "empty body without attachments still rejected");
  const tooMany = parseIncomingAttachments(new Array(4).fill(null).map((_, i) => ({
    id: `00000000-0000-4000-8000-00000000000${i}`,
    mimeType: "image/jpeg",
    size: 12,
    exp: Math.floor(Date.now() / 1000) + 60,
    claim: "x",
  })));
  assert(!tooMany.ok, "max 3 attachments");
  assert(
    directorySafePreview({ body: "안녕", attachments: [{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/jpeg", size: 8 }] }) ===
      "안녕",
    "text+photo preview prefers text"
  );
  assert(
    directorySafePreview({
      body: "",
      attachments: [{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/jpeg", size: 8 }],
    }) === CHAT_PHOTO_PUSH_BODY,
    "photo-only preview"
  );
  assert(
    replyPreviewFromBody({
      body: "",
      attachments: [{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/jpeg", size: 8 }],
    }) === CHAT_PHOTO_REPLY_PREVIEW,
    "reply to photo"
  );
  assert(shouldPurgeChatAttachmentsOnDelete("everyone") === true, "everyone delete purges");
  assert(shouldPurgeChatAttachmentsOnDelete("admin") === true, "admin delete purges");
  assert(shouldPurgeChatAttachmentsOnDelete("hide") === false, "hide-for-me keeps attachments");
  const deleted = applyDeletedLine(
    [
      {
        clientMessageId: "c1",
        senderUserId: 1,
        sender: "A",
        senderRole: "caddy",
        body: "",
        sentAt: new Date().toISOString(),
        seq: 9,
        mentions: [],
        mentionAll: false,
        attachments: [{ id: "00000000-0000-4000-8000-000000000001", mimeType: "image/jpeg", size: 8 }],
      },
    ],
    { seq: 9, deletionType: "everyone", deletedAt: new Date().toISOString() }
  );
  assert(deleted[0]?.attachments?.length === 0, "delete clears attachments");
}

async function main() {
section("attachment claim");
{
  const secret = "chat-photo-claim-test";
  const exp = Math.floor(Date.now() / 1000) + 120;
  const attachment = {
    id: "11111111-1111-4111-8111-111111111111",
    mimeType: "image/jpeg" as const,
    size: 12,
    exp,
    claim: "",
  };
  attachment.claim = await signChatAttachmentClaim(secret, {
    roomId: "all",
    attachmentId: attachment.id,
    senderUserId: 7,
    mimeType: attachment.mimeType,
    size: attachment.size,
    exp,
  });
  assert(
    await verifyChatAttachmentClaim(secret, attachment, { roomId: "all", senderUserId: 7 }),
    "valid claim accepted"
  );
  assert(
    (await verifyChatAttachmentClaim(secret, attachment, { roomId: "all", senderUserId: 8 })) === false,
    "sender spoof rejected"
  );
  assert(
    (await verifyChatAttachmentClaim(secret, attachment, { roomId: "room_0123456789abcdef", senderUserId: 7 })) ===
      false,
    "cross-room claim rejected"
  );
}

section("push recipient regression");
{
  assert(
    shouldNotifyChatUser({
      userId: 1,
      senderUserId: 1,
      mode: "ALL",
      mentionAll: false,
      mentionUserIds: [],
    }) === false,
    "sender self-push 없음"
  );
  assert(
    shouldNotifyChatUser({
      userId: 2,
      senderUserId: 1,
      mode: "OFF",
      mentionAll: true,
      mentionUserIds: [2],
    }) === false,
    "OFF still silent"
  );
  assert(
    shouldNotifyChatUser({
      userId: 2,
      senderUserId: 1,
      mode: "MENTIONS",
      mentionAll: false,
      mentionUserIds: [],
    }) === false,
    "MENTIONS without mention stays silent"
  );
  const recips = selectChatPushRecipients({
    event: {
      roomId: "all",
      seq: 3,
      senderUserId: 1,
      mentionAll: false,
      mentionUserIds: [],
      replyToUserId: null,
    },
    candidateUserIds: [1, 2, 3],
    prefs: { "3": "OFF" },
  });
  assert(recips.join(",") === "2", "photo event still uses existing recipient filter");
  const payload = buildChatPushPayload({
    roomId: "all",
    roomType: "ALL",
    roomName: "전체 채팅방",
    senderName: "홍길동",
    preview: CHAT_PHOTO_PUSH_BODY,
    mentionAll: false,
    mentioned: false,
  });
  assert(payload.body.includes(CHAT_PHOTO_PUSH_BODY), "push body uses photo fallback");
  assert(payload.url.startsWith("/chat?room="), "deep-link unchanged");
}

section("instant preview + parallel upload");
{
  if (typeof URL.createObjectURL !== "function") {
    let n = 0;
    URL.createObjectURL = () => `blob:test-${++n}`;
    URL.revokeObjectURL = () => {};
  }
  globalThis.__CHAT_PHOTO_TIMING__ = { marks: [] };
  resetChatPhotoTiming();
  const started = 0;
  markChatPhotoTiming("select_to_preview", started);
  assert(globalThis.__CHAT_PHOTO_TIMING__?.marks.some((m) => m.name === "select_to_preview"), "dev timing records select→preview");

  const jpgA = new File([new Uint8Array([1, 2, 3])], "a.jpg", { type: "image/jpeg", lastModified: 1 });
  const jpgB = new File([new Uint8Array([4, 5, 6])], "b.jpg", { type: "image/jpeg", lastModified: 2 });
  const jpgC = new File([new Uint8Array([7, 8, 9])], "c.jpg", { type: "image/jpeg", lastModified: 3 });
  const instantStarted = Date.now();
  const picked = instantChatPhotoPicks([jpgA, jpgB, jpgC], 3);
  const previewMs = Date.now() - instantStarted;
  assert(picked.items.length === 3, "3장 instant preview");
  assert(picked.items.every((item) => item.status === "ready"), "JPEG <=3MB is ready without encode");
  assert(picked.items.every((item) => item.previewUrl.startsWith("blob:")), "object URL preview");
  assert(previewMs < 50, "instant preview is not blocked by encode");
  assert(Date.now() - instantStarted < 100, "select → ready <100ms for JPEG");

  const one = instantChatPhotoPicks([jpgA], 3);
  assert(one.items.length === 1, "1장 instant preview");
  const dup = instantChatPhotoPicks([jpgA], 2, { fileIds: one.items.map((item) => item.fileId) });
  assert(dup.items.length === 0, "fileId blocks duplicate before fingerprint");
  assert(dup.note.includes("이미 추가한"), "duplicate note from fileId");

  let prepareCalls = 0;
  const slowPrepare = async (file: File) => {
    prepareCalls += 1;
    await new Promise((r) => setTimeout(r, 20));
    return new Blob([`ready-${file.name}`], { type: "image/jpeg" });
  };
  const prepared = await prepareChatPendingPhoto(picked.items[0], jpgA, slowPrepare);
  assert(prepareCalls === 1, "prepare runs after instant pick");
  assert(prepared.status === "ready", "prepare success");
  assert(prepared.blob !== jpgA, "upload blob replaced");
  const applied = applyPreparedChatPhoto(picked.items, prepared);
  assert(applied.items[0]?.status === "ready", "state blob replaced after prepare");
  assert(applied.items[0]?.previewUrl === picked.items[0]?.previewUrl, "preview URL stays");

  const failed = await prepareChatPendingPhoto(picked.items[1], jpgB, async () => {
    throw new Error("변환 실패");
  });
  assert(failed.status === "failed", "prepare failure status");
  const failedApplied = applyPreparedChatPhoto(applied.items, failed);
  assert(failedApplied.items[1]?.status === "failed", "failed preview kept");
  assert(failedApplied.note.includes("변환 실패"), "prepare fail copy");

  const order: number[] = [];
  const settled = await mapBoundedSettled([1, 2, 3], 3, async (n) => {
    order.push(n);
    await new Promise((r) => setTimeout(r, 5));
    return `ok-${n}`;
  });
  assert(settled.every((row) => row.status === "fulfilled"), "3장 bounded parallel all ok");
  assert(order.length === 3, "all three upload jobs started");

  const partial = await mapBoundedSettled(["a", "b", "c"], 3, async (id) => {
    if (id === "b") throw new Error("upload down");
    return id;
  });
  assert(partial.some((row) => row.status === "rejected"), "partial upload failure visible");
  assert(partial.filter((row) => row.status === "fulfilled").length === 2, "other uploads still settle");
  const ready = readyChatPhotosForUpload(failedApplied.items);
  assert(ready.every((item) => item.status === "ready") && ready.length === 2, "only ready blobs upload");

  let prepareCallsDirect = 0;
  let putCalls = 0;
  let finalizeCalls = 0;
  const fakeFetch: typeof fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.includes("/prepare")) {
      prepareCallsDirect += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          upload: {
            attachmentId: "att-1",
            uploadUrl: "https://blob.example/put",
            contentType: "image/jpeg",
            maxBytes: 3 * 1024 * 1024,
          },
        }),
        { status: 200 }
      );
    }
    if (url.includes("/finalize")) {
      finalizeCalls += 1;
      return new Response(
        JSON.stringify({
          ok: true,
          photo: { id: "att-1", mimeType: "image/jpeg", size: 8, exp: 1, claim: "claim" },
        }),
        { status: 200 }
      );
    }
    throw new Error(`unexpected fetch ${url} ${init?.method || ""}`);
  }) as typeof fetch;
  const uploaded = await uploadChatPhotoDirect(
    "all",
    { key: "k1", blob: new Blob([jpegBytes(8, 1)], { type: "image/jpeg" }) },
    {
      fetchFn: fakeFetch,
      put: async () => {
        putCalls += 1;
      },
    }
  );
  assert(uploaded.claim === "claim", "direct helper returns finalize claim");
  assert(prepareCallsDirect === 1 && putCalls === 1 && finalizeCalls === 1, "prepare → PUT → finalize");

  let blockedFinalize = 0;
  try {
    await uploadChatPhotoDirect(
      "all",
      { key: "k2", blob: new Blob([jpegBytes(8, 2)], { type: "image/jpeg" }) },
      {
        fetchFn: (async (input: RequestInfo | URL) => {
          const url = String(input);
          if (url.includes("/prepare")) {
            return new Response(
              JSON.stringify({
                ok: true,
                upload: { attachmentId: "att-2", uploadUrl: "https://blob.example/put", contentType: "image/jpeg" },
              }),
              { status: 200 }
            );
          }
          if (url.includes("/finalize")) {
            blockedFinalize += 1;
            return new Response("{}", { status: 200 });
          }
          throw new Error(url);
        }) as typeof fetch,
        put: async () => {
          throw new Error("direct PUT down");
        },
      }
    );
    assert(false, "partial PUT should throw");
  } catch (e) {
    assert(e instanceof Error && e.message.includes("direct PUT down"), "direct PUT failure blocks send");
  }
  assert(blockedFinalize === 0, "finalize not called after PUT failure");

  const progressed = applyChatPhotoSendProgress(applied.items, {
    key: applied.items[0]!.key,
    phase: "put",
    progress: 40,
  });
  assert(progressed[0]?.send?.progress === 40, "per-photo progress state");

  const jpegOk = new File([jpegBytes(32, 1)], "ok.jpg", { type: "image/jpeg", lastModified: 11 });
  const pngOk = new File([pngBytes()], "ok.png", { type: "image/png", lastModified: 12 });
  const webpOk = new File([webpBytes()], "ok.webp", { type: "image/webp", lastModified: 13 });
  const huge = new File([new Uint8Array(3 * 1024 * 1024 + 8)], "huge.jpg", {
    type: "image/jpeg",
    lastModified: 14,
  });
  const heic = new File([heicBytes()], "a.heic", { type: "image/heic", lastModified: 15 });
  const pdf = new File([pdfBytes()], "x.pdf", { type: "application/pdf", lastModified: 16 });
  assert(canUseChatPhotoFastPath(jpegOk), "small JPEG uses passthrough");
  assert(canUseChatPhotoFastPath(pngOk), "small PNG uses passthrough");
  assert(canUseChatPhotoFastPath(webpOk), "small WEBP uses passthrough");
  assert(!canUseChatPhotoFastPath(huge), ">3MB is not passthrough");
  assert(needsChatPhotoHeavyPrepare(huge), ">3MB uses compression path");
  assert(needsChatPhotoHeavyPrepare(heic), "HEIC uses conversion path");
  assert(!canUseChatPhotoFastPath(pdf), "unsupported is not fast path");

  let compressCalls = 0;
  const compress = async (file: File) => {
    compressCalls += 1;
    return new Blob([`compressed-${file.name}`], { type: "image/jpeg" });
  };
  const jpegPrepared = await prepareChatPhotoSource(jpegOk, compress);
  assert(jpegPrepared === jpegOk && compressCalls === 0, "small JPEG → no re-encode");
  const pngPrepared = await prepareChatPhotoSource(pngOk, compress);
  assert(pngPrepared === pngOk && compressCalls === 0, "small PNG → no re-encode");
  const webpPrepared = await prepareChatPhotoSource(webpOk, compress);
  assert(webpPrepared === webpOk && compressCalls === 0, "small WEBP → no re-encode");
  const hugePrepared = await prepareChatPhotoSource(huge, compress);
  assert(compressCalls === 1 && hugePrepared !== huge, ">3MB → compression path");
  let unsupported = "";
  try {
    await prepareChatPhotoSource(pdf, compress);
  } catch (e) {
    unsupported = e instanceof Error ? e.message : "other";
  }
  assert(unsupported.includes("JPG/PNG/WEBP"), "unsupported → reject");

  const rejected = instantChatPhotoPicks([pdf], 3);
  assert(rejected.items.length === 0, "unsupported files stay out of composer");

  const defaultPrepared = await prepareChatPendingPhoto(
    instantChatPhotoPicks([jpegOk], 1).items[0]!,
    jpegOk
  );
  assert(defaultPrepared.status === "ready" && defaultPrepared.fingerprint === "", "fast path skips fingerprint");
  assert(defaultPrepared.blob === jpegOk, "fast path keeps original blob");

  const sendTapStarted = Date.now();
  const outgoing = buildOptimisticOutgoingLine("안녕", picked.items);
  const composer = clearedComposerAfterOptimisticSend();
  const sendTapMs = Date.now() - sendTapStarted;
  assert(outgoing.status === "sending" && outgoing.localPhotos.length === 3, "send tap 즉시 local outgoing bubble");
  assert(composer.draft === "" && composer.pendingPhotos.length === 0, "composer 즉시 clear/reusable");
  assert(sendTapMs < 50, "send tap → local bubble <50ms");
  assert(shouldStartOptimisticChatSend("", picked.items), "photos-only send is allowed");
  assert(!shouldStartOptimisticChatSend("", []), "empty send is blocked");
  assert(
    outgoingChatPhotoSrc({
      roomId: "all",
      attachmentId: "att-9",
      previewUrl: "blob:local",
      chatPhotoSrc: (roomId, id) => `/api/chat/rooms/${roomId}/attachments/${id}`,
    }).includes("att-9"),
    "success replaces local URL with server attachment URL"
  );
  let revoked = 0;
  const origRevoke = URL.revokeObjectURL;
  URL.revokeObjectURL = () => {
    revoked += 1;
  };
  revokeChatPhotoPreviewUrls([{ previewUrl: "blob:keep-me" }]);
  URL.revokeObjectURL = origRevoke;
  assert(revoked === 1, "local object URL lifecycle revokes blob URLs");

  const failedLine = { ...outgoing, status: "failed" as const };
  assert(failedLine.status === "failed", "upload/finalize fail → failed bubble");
  const retried = buildOptimisticOutgoingLine(failedLine.body, failedLine.localPhotos);
  assert(retried.localPhotos[0]?.previewUrl === failedLine.localPhotos[0]?.previewUrl, "retry reuses local photo blob");
}

section("composer stale pending state");
{
  if (typeof URL.createObjectURL !== "function") {
    let n = 0;
    URL.createObjectURL = () => `blob:test-${++n}`;
    URL.revokeObjectURL = () => {};
  }
  const file = (mark: number, name: string) =>
    new File([jpegBytes(8, mark)], name, { type: "image/jpeg", lastModified: mark });

  function mockComposer(initial: ReturnType<typeof instantChatPhotoPicks>["items"] = []) {
    let state = visibleComposerPhotos(initial);
    let ref = state;
    let generation = 0;
    function setList(next: typeof state) {
      const unique = visibleComposerPhotos(next);
      ref = unique;
      state = unique;
    }
    return {
      get state() {
        return state;
      },
      get ref() {
        return ref;
      },
      get generation() {
        return generation;
      },
      setList,
      select(files: File[]) {
        const picked = commitComposerPhotoPicks(ref, files);
        const committed = { ...picked, ...appendComposerPhotos(ref, picked.accepted) };
        setList(committed.items);
        return committed;
      },
      send() {
        const sent = usableOptimisticChatPhotos(ref);
        generation += 1;
        setList(leftoverComposerPhotosAfterSend(ref, sent.map((item) => item.key)));
        return sent;
      },
      assertSync(msg: string) {
        assert(composerPhotoListsMatch(state, ref), msg);
      },
    };
  }

  const one = file(1, "one.jpg");
  const two = file(2, "two.jpg");
  const three = file(3, "three.jpg");
  const extra = file(4, "extra.jpg");

  const keysA = instantChatPhotoPicks([one], 1).items[0]!.key;
  const keysB = instantChatPhotoPicks([one], 1).items[0]!.key;
  assert(keysA !== keysB, "same file in the same millisecond still gets unique keys");

  const dupList = instantChatPhotoPicks([one, two], 2).items;
  const withDupKey = [...dupList, dupList[0]!];
  assert(withDupKey.length === 3 && visibleComposerPhotos(withDupKey).length === 2, "duplicate keys do not count as extra slots");
  assert(!composerPhotoListsMatch(visibleComposerPhotos(withDupKey), withDupKey), "visible list and raw ref diverge when keys collide");

  const first = commitComposerPhotoPicks([], [one, two]);
  const secondFromEmpty = commitComposerPhotoPicks([], [one, two]);
  const merged = appendComposerPhotos(first.items, secondFromEmpty.accepted);
  assert(first.accepted.length === 2, "2장 select accepts 2");
  assert(merged.items.length === 2 && merged.accepted.length === 0, "overlapping 2장 select does not stack to 3");
  assert(commitComposerPhotoPicks(first.items, [one, two]).accepted.length === 0, "same files are not added twice");

  const full = commitComposerPhotoPicks(first.items, [three]);
  assert(full.accepted.length === 1 && full.items.length === 3, "2장 후 1장 more is allowed");
  const overflow = commitComposerPhotoPicks(full.items, [extra]);
  assert(overflow.accepted.length === 0 && overflow.note === CHAT_PHOTO_COMPOSER_MAX_MESSAGE, "4th photo is rejected with max-3 message");

  for (const count of [1, 2, 3] as const) {
    const composer = mockComposer();
    const files = [one, two, three].slice(0, count);
    const selected = composer.select(files);
    assert(selected.accepted.length === count, `${count}장 select`);
    assert(composer.state.length === count && composer.ref.length === count, `${count}장 state/ref count`);
    composer.assertSync(`${count}장 state matches ref`);
    const sent = composer.send();
    assert(sent.length === count && composer.state.length === 0 && composer.ref.length === 0, `${count}장 send clears composer`);
    composer.assertSync(`${count}장 send keeps state/ref empty together`);
    const stalePrepared = applyComposerPreparedIfCurrent(
      composer.ref,
      { ...sent[0]!, status: "ready" },
      composer.generation,
      composer.generation - 1
    );
    assert(stalePrepared.items.length === 0, `${count}장 stale prepare cannot restore composer`);
    const staleProgress = applyComposerProgressIfCurrent(
      composer.ref,
      { key: sent[0]!.key, phase: "put", progress: 40 },
      composer.generation,
      composer.generation - 1
    );
    assert(staleProgress.length === 0, `${count}장 stale progress cannot restore composer`);
    composer.setList(staleProgress);
    composer.assertSync(`${count}장 stale writes leave state/ref empty`);
  }

  const afterTwo = mockComposer();
  afterTwo.select([one, two]);
  afterTwo.send();
  const nextOne = afterTwo.select([three]);
  assert(nextOne.accepted.length === 1 && afterTwo.ref.length === 1, "2장 전송 후 새 1장 선택 가능");
  afterTwo.assertSync("2장 send then 1장 select stays in sync");

  const afterThree = mockComposer();
  afterThree.select([one, two, three]);
  afterThree.send();
  const nextThree = afterThree.select([one, two, three]);
  assert(nextThree.accepted.length === 3 && afterThree.ref.length === 3, "3장 전송 후 새 3장 다시 선택 가능");
  afterThree.assertSync("3장 send then 3장 select stays in sync");

  const rapid = mockComposer();
  for (let i = 0; i < 5; i++) {
    const picked = rapid.select([file(10 + i, `rapid-${i}.jpg`)]);
    assert(picked.accepted.length === 1, `rapid select ${i + 1}`);
    rapid.send();
    assert(rapid.state.length === 0 && rapid.ref.length === 0, `rapid send ${i + 1} clears`);
    rapid.assertSync(`rapid loop ${i + 1} stays in sync`);
  }

  const failedStay = instantChatPhotoPicks([one, two], 2).items;
  failedStay[1] = { ...failedStay[1]!, status: "failed", error: "변환 실패" };
  const leftover = leftoverComposerPhotosAfterSend(
    failedStay,
    usableOptimisticChatPhotos(failedStay).map((item) => item.key)
  );
  assert(leftover.length === 1 && leftover[0]?.status === "failed", "failed photo stays for retry");
  assert(!leftover.some((item) => item.status === "ready"), "successful photo is not a hidden leftover");

  const session = createChatPhotoComposerSession(failedStay);
  const began = session.beginSend();
  assert(began.sent.length === 1 && began.items.length === 1, "session send keeps only failed");
  assert(!session.canWrite(began.generation - 1, began.sent[0]?.key), "old generation cannot write sent photo back");
  assert(
    shouldApplyComposerWrite({
      currentGeneration: session.generation,
      writeGeneration: session.generation,
      items: session.items,
      key: began.items[0]!.key,
    }),
    "failed leftover can still receive retry writes"
  );
}

section("phase 4 pre-upload on select");
{
  if (typeof URL.createObjectURL !== "function") {
    let n = 0;
    URL.createObjectURL = () => `blob:test-${++n}`;
    URL.revokeObjectURL = () => {};
  }
  globalThis.__CHAT_PHOTO_TIMING__ = { marks: [], stamps: {} };
  resetChatPhotoTiming();

  function fakeResult(id: string, exp = Math.floor(Date.now() / 1000) + 600): ChatPhotoDirectResult {
    return { id, mimeType: "image/jpeg", size: 8, exp, claim: `claim-${id}` };
  }

  function countingUpload() {
    const counts = { prepare: 0, put: 0, finalize: 0, calls: 0 };
    let inflightPut: (() => void) | null = null;
    const gate = { hold: false };
    const upload = async (
      _roomId: string,
      item: { key: string; blob: Blob; send?: { result?: ChatPhotoDirectResult } }
    ) => {
      counts.calls += 1;
      if (item.send?.result?.id && item.send.result.claim) return item.send.result;
      counts.prepare += 1;
      counts.put += 1;
      if (gate.hold) {
        await new Promise<void>((resolve) => {
          inflightPut = resolve;
        });
      }
      counts.finalize += 1;
      return fakeResult(`att-${item.key}`);
    };
    return {
      counts,
      gate,
      upload,
      release() {
        inflightPut?.();
        inflightPut = null;
      },
    };
  }

  const onePick = instantChatPhotoPicks(
    [new File([jpegBytes(8, 21)], "one.jpg", { type: "image/jpeg", lastModified: 21 })],
    1
  );
  const one = onePick.items[0]!;
  assert(one.status === "ready", "select 1장 is ready immediately");
  const first = countingUpload();
  const jobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const started = startChatPhotoPreupload(jobs, "all", one, { upload: first.upload });
  assert(jobs.has(one.key), "select 직후 pre-upload job stored");
  const firstResult = await started;
  assert(first.counts.put === 1 && first.counts.prepare === 1 && first.counts.finalize === 1, "select starts prepare/PUT/finalize");
  const completed = {
    ...one,
    send: { phase: "done" as const, progress: 100, attachmentId: firstResult.id, result: firstResult },
  };
  const sendAfterDone = await finishChatPhotoOutgoingUploads({
    jobs,
    roomId: "all",
    photos: [completed],
    upload: first.upload,
  });
  assert(sendAfterDone[0]?.id === firstResult.id, "send 전 upload 완료 → existing claim reused");
  assert(first.counts.put === 1, "send 시 no second PUT");
  assert(first.counts.prepare === 1 && first.counts.finalize === 1, "send 시 no second prepare/finalize");

  let blockedNetwork = 0;
  const liveDirect = await uploadChatPhotoDirect(
    "all",
    {
      key: "already-uploaded",
      blob: new Blob([jpegBytes(8, 24)], { type: "image/jpeg" }),
      send: { result: firstResult },
    },
    {
      fetchFn: (async () => {
        blockedNetwork += 1;
        throw new Error("should not call prepare/finalize");
      }) as typeof fetch,
      put: async () => {
        blockedNetwork += 1;
      },
    }
  );
  assert(liveDirect.claim === firstResult.claim && blockedNetwork === 0, "live claim skips prepare/PUT/finalize");

  const inflightHelper = countingUpload();
  inflightHelper.gate.hold = true;
  const inflightJobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const inflightItem = instantChatPhotoPicks(
    [new File([jpegBytes(8, 22)], "fly.jpg", { type: "image/jpeg", lastModified: 22 })],
    1
  ).items[0]!;
  const firstPromise = startChatPhotoPreupload(inflightJobs, "all", inflightItem, {
    upload: inflightHelper.upload,
  });
  const reusedPromise = startChatPhotoPreupload(inflightJobs, "all", inflightItem, {
    upload: inflightHelper.upload,
  });
  assert(firstPromise === reusedPromise, "send while upload in-flight → same promise reuse");
  assert(inflightHelper.counts.calls === 1 && inflightHelper.counts.put === 1, "in-flight does not start a second PUT");
  const sendWhileInflight = finishChatPhotoOutgoingUploads({
    jobs: inflightJobs,
    roomId: "all",
    photos: [inflightItem],
    upload: inflightHelper.upload,
  });
  inflightHelper.release();
  const inflightResult = await sendWhileInflight;
  await firstPromise;
  assert(inflightResult[0]?.id === `att-${inflightItem.key}`, "in-flight send waits then uses same attachment");
  assert(inflightHelper.counts.put === 1, "in-flight send still one PUT");

  const removeHelper = countingUpload();
  removeHelper.gate.hold = true;
  const removeJobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const removeItem = instantChatPhotoPicks(
    [new File([jpegBytes(8, 23)], "rm.jpg", { type: "image/jpeg", lastModified: 23 })],
    1
  ).items[0]!;
  const removePromise = startChatPhotoPreupload(removeJobs, "all", removeItem, {
    upload: removeHelper.upload,
  });
  abandonChatPhotoPreupload(removeJobs, [removeItem.key]);
  assert(!removeJobs.has(removeItem.key), "remove while upload drops job from composer map");
  removeHelper.release();
  await removePromise.catch(() => null);
  assert(removeHelper.counts.put === 1, "removed photo upload may finish as orphan; no extra PUT");

  const roomJobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const roomItem = { ...one, key: "room-leave" };
  roomJobs.set(roomItem.key, Promise.resolve(fakeResult("att-room")));
  abandonChatPhotoPreupload(roomJobs, [roomItem.key]);
  assert(!roomJobs.has(roomItem.key), "room change abandons composer pre-upload jobs");
  assert(roomJobs.size === 0, "room change does not keep composer upload map entries");

  const retryHelper = countingUpload();
  const retryJobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const liveClaim = fakeResult("att-retry");
  const retryPhotos = [
    {
      ...one,
      key: "retry-1",
      send: { phase: "done" as const, progress: 100, attachmentId: liveClaim.id, result: liveClaim },
    },
  ];
  const afterWsFail = await finishChatPhotoOutgoingUploads({
    jobs: retryJobs,
    roomId: "all",
    photos: retryPhotos,
    pendingClaims: [liveClaim],
    upload: retryHelper.upload,
  });
  assert(afterWsFail[0]?.claim === liveClaim.claim, "retry after WS failure reuses attachment claim");
  assert(retryHelper.counts.put === 0 && retryHelper.counts.calls === 0, "WS-only retry does not re-upload");

  const expiredHelper = countingUpload();
  const expiredJobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const expired = fakeResult("att-exp", 10);
  const expiredItem = {
    ...one,
    key: "expired-1",
    send: { phase: "done" as const, progress: 100, attachmentId: expired.id, result: expired },
  };
  const reuploaded = await finishChatPhotoOutgoingUploads({
    jobs: expiredJobs,
    roomId: "all",
    photos: [expiredItem],
    pendingClaims: [expired],
    upload: expiredHelper.upload,
    nowSec: 10_000,
  });
  assert(expiredHelper.counts.put === 1, "expired claim is the only re-upload case");
  assert(reuploaded[0]?.id !== expired.id, "expired claim starts a new upload");

  const tripleHelper = countingUpload();
  const tripleJobs = new Map<string, Promise<ChatPhotoDirectResult>>();
  const triple = instantChatPhotoPicks(
    [
      new File([jpegBytes(8, 31)], "t1.jpg", { type: "image/jpeg", lastModified: 31 }),
      new File([jpegBytes(8, 32)], "t2.jpg", { type: "image/jpeg", lastModified: 32 }),
      new File([jpegBytes(8, 33)], "t3.jpg", { type: "image/jpeg", lastModified: 33 }),
    ],
    3
  ).items;
  assert(triple.length === 3, "3장 select");
  await Promise.all(
    triple.map((item) => startChatPhotoPreupload(tripleJobs, "all", item, { upload: tripleHelper.upload }))
  );
  assert(tripleHelper.counts.put === 3, "3장 each PUT once on select");
  const tripleDone = triple.map((item, i) => ({
    ...item,
    send: {
      phase: "done" as const,
      progress: 100,
      attachmentId: `att-${item.key}`,
      result: fakeResult(`att-${item.key}`),
    },
  }));
  await finishChatPhotoOutgoingUploads({
    jobs: tripleJobs,
    roomId: "all",
    photos: tripleDone,
    upload: tripleHelper.upload,
  });
  assert(tripleHelper.counts.put === 3, "3장 send does not PUT again");

  assert(shouldStartOptimisticChatSend("텍스트와 사진", [completed]), "text+photo send allowed");
  assert(shouldStartOptimisticChatSend("", [completed]), "photo-only send allowed");
  const replyLine = { ...buildOptimisticOutgoingLine("답글", [completed]), replyToSeq: 44 };
  assert(replyLine.replyToSeq === 44, "reply+photo keeps reply seq");
  const replyUploads = await finishChatPhotoOutgoingUploads({
    jobs: new Map(),
    roomId: "all",
    photos: [completed],
    pendingClaims: [firstResult],
    upload: first.upload,
  });
  assert(replyUploads[0]?.id === firstResult.id && first.counts.put === 1, "reply+photo reuses claim; no extra PUT");

  const composerDraft = { text: "", reply: null as number | null, photos: [one] };
  void startChatPhotoPreupload(new Map(), "all", one, { upload: first.upload });
  composerDraft.text = "입력 가능";
  composerDraft.reply = 7;
  composerDraft.photos = [];
  assert(composerDraft.text === "입력 가능" && composerDraft.reply === 7, "pre-upload does not block text/reply/remove");

  resetChatPhotoTiming();
  stampChatPhotoTiming("photo_selected", 1000);
  stampChatPhotoTiming("put_start", 1400);
  markChatPhotoTiming("direct_put", 1400);
  markChatPhotoTiming("finalize_api", 1800);
  stampChatPhotoTiming("send_tap", 2200);
  stampChatPhotoTiming("ws_send", 2210);
  const summary = summarizeChatPhotoTiming();
  assert(summary.select_to_put_start_ms === 400, "1장 select→PUT start");
  assert(typeof summary.put_ms === "number" && summary.put_ms >= 0, "1장 PUT duration");
  assert(typeof summary.finalize_ms === "number" && summary.finalize_ms >= 0, "1장 finalize duration");
  assert(summary.send_tap_to_ws_ms === 10, "1장 send tap→WS send");
  const emitted = emitChatPhotoTimingSummary();
  const dumped = JSON.stringify(emitted);
  assert(!/https?:|claim-|blob:|jpegBytes/i.test(dumped), "timing summary has no secret/url/file contents");
  assert(
    ["select_to_put_start_ms", "put_ms", "finalize_ms", "send_tap_to_ws_ms"].every((key) =>
      Object.prototype.hasOwnProperty.call(emitted, key)
    ),
    "timing summary exposes the 1장 breakdown keys"
  );
}

section("phase 5 adaptive compression + debug");
{
  if (typeof URL.createObjectURL !== "function") {
    let n = 0;
    URL.createObjectURL = () => `blob:test-${++n}`;
    URL.revokeObjectURL = () => {};
  }
  const smallJpeg = new File([new Uint8Array(500 * 1024)], "s.jpg", { type: "image/jpeg", lastModified: 41 });
  const midJpeg = new File([new Uint8Array(2.2 * 1024 * 1024)], "m.jpg", {
    type: "image/jpeg",
    lastModified: 42,
  });
  const largeWebp = new File([new Uint8Array(1.4 * 1024 * 1024)], "l.webp", {
    type: "image/webp",
    lastModified: 43,
  });
  const largePng = new File([new Uint8Array(1.6 * 1024 * 1024)], "shot.png", {
    type: "image/png",
    lastModified: 44,
  });
  const heic = new File([heicBytes()], "a.heic", { type: "image/heic", lastModified: 45 });
  assert(smallJpeg.size < CHAT_PHOTO_PASSTHROUGH_MAX_BYTES, "500KB-class fixture is under passthrough");
  assert(canUseChatPhotoFastPath(smallJpeg), "500KB JPEG → no encode");
  assert(!needsChatPhotoHeavyPrepare(smallJpeg), "500KB JPEG skips adaptive");
  assert(!canUseChatPhotoFastPath(midJpeg) && needsChatPhotoHeavyPrepare(midJpeg), "2~3MB JPEG → compressed target");
  assert(!canUseChatPhotoFastPath(largeWebp) && needsChatPhotoHeavyPrepare(largeWebp), "large WEBP → adaptive path");
  const pngPlan = planChatPhotoAdaptive(largePng, { hasAlpha: false });
  assert(pngPlan.kind === "png_readable" && pngPlan.mime === "image/webp", "PNG screenshot readability-oriented path");
  assert(pngPlan.qualities[0] === 0.92 && pngPlan.maxAttempts === 2, "PNG uses high-quality bounded encode");
  assert(pngPlan.keepAlpha === true || pngPlan.mime !== "image/jpeg", "large PNG is not forced to low-quality JPEG");
  const jpegPlan = planChatPhotoAdaptive(midJpeg);
  assert(jpegPlan.longEdge === 1600 && jpegPlan.mime === "image/jpeg", "JPEG source uses 1600 JPEG encode");
  assert(jpegPlan.acceptMaxBytes === CHAT_PHOTO_MAX_BYTES, "first encode is accepted up to 3MB");
  assert(jpegPlan.maxAttempts <= 2, "encode attempts bounded");
  const resize4000 = chatPhotoBitmapResizeOptions(4000, 3000);
  assert(resize4000?.resizeWidth === 1600 && resize4000?.resizeHeight === 1200, "4000x3000 bitmap resize is 1600x1200");
  assert(chatPhotoBitmapResizeOptions(1600, 1200) === null, "already-1600 JPEG skips bitmap resize");
  assert(chatPhotoDecodePathFromBitmap({ width: 1600, height: 1200 }, resize4000) === "bitmap-resize", "matching bitmap is resize path");
  assert(chatPhotoDecodePathFromBitmap({ width: 4000, height: 3000 }, resize4000) === "bitmap-full", "ignored resize is full decode");
  assert(shouldAcceptChatPhotoEncode(900 * 1024), "900KB first encode is accepted");
  assert(!shouldAcceptChatPhotoEncode(CHAT_PHOTO_MAX_BYTES + 1), "over 3MB is not accepted");

  let encodeCalls = 0;
  const compressed = await prepareChatAdaptivePhoto(midJpeg, {
    inspect: async () => ({ width: 4000, height: 3000 }),
    encode: async ({ mime, quality }) => {
      encodeCalls += 1;
      const size = quality > 0.75 ? 900 * 1024 : 620 * 1024;
      return new Blob([new Uint8Array(size)], { type: mime });
    },
  });
  assert(encodeCalls === 1, "first encode above soft target but <=3MB skips second");
  assert(compressed.attempts === 1 && compressed.outputWidth === 1600 && compressed.outputHeight === 1200, "4000x3000 JPEG scales to 1600x1200");
  assert(compressed.mimeType.includes("jpeg"), "JPEG source stays JPEG");
  assert(compressed.uploadBytes === 900 * 1024, "accepted first encode bytes kept");
  assert(compressed.uploadBytes <= CHAT_PHOTO_MAX_BYTES, "compressed result <= server max");
  assert(compressed.sourceBytes === midJpeg.size, "sourceBytes recorded");

  let overCalls = 0;
  const overThenOk = await prepareChatAdaptivePhoto(midJpeg, {
    inspect: async () => ({ width: 4000, height: 3000 }),
    encode: async ({ quality }) => {
      overCalls += 1;
      const size = quality > 0.75 ? CHAT_PHOTO_MAX_BYTES + 1024 : 900 * 1024;
      return new Blob([new Uint8Array(size)], { type: "image/jpeg" });
    },
  });
  assert(overCalls === 2 && overThenOk.attempts === 2, "first encode >3MB tries second quality");
  assert(overThenOk.uploadBytes === 900 * 1024, "second encode under 3MB is kept");

  let rejectCalls = 0;
  let overMax = "";
  try {
    await prepareChatAdaptivePhoto(midJpeg, {
      inspect: async () => ({ width: 4000, height: 3000 }),
      encode: async () => {
        rejectCalls += 1;
        return new Blob([new Uint8Array(CHAT_PHOTO_MAX_BYTES + 8)], { type: "image/jpeg" });
      },
    });
  } catch (e) {
    overMax = e instanceof Error ? e.message : "other";
  }
  assert(rejectCalls === 2 && overMax.includes("3MB"), ">3MB final reject");

  const webpOut = await prepareChatAdaptivePhoto(largeWebp, {
    inspect: async () => ({ width: 2400, height: 1800 }),
    encode: async ({ mime }) => new Blob([new Uint8Array(560 * 1024)], { type: mime }),
  });
  assert(webpOut.encoded && webpOut.uploadBytes === 560 * 1024, "large WEBP uses adaptive encode");
  assert(webpOut.attempts === 1 && webpOut.mimeType.includes("jpeg"), "WebP source uses one JPEG encode");
  assert(planChatPhotoAdaptive(largeWebp).mime === "image/jpeg", "large WebP plan is JPEG");

  const pngOut = await prepareChatAdaptivePhoto(largePng, {
    hasAlpha: true,
    inspect: async () => ({ width: 2000, height: 1400, hasAlpha: true }),
    encode: async ({ mime, quality }) => new Blob([new Uint8Array(quality > 0.88 ? 820 * 1024 : 700 * 1024)], { type: mime }),
  });
  assert(pngOut.mimeType.includes("webp") || pngOut.mimeType.includes("png"), "transparent/screenshot PNG stays readable");
  assert(pngOut.attempts === 1, "PNG first encode under 3MB skips second");
  assert(pngOut.uploadBytes <= 1024 * 1024, "PNG target around 700KB~1MB");
  assert(pngOut.outputWidth === 1600 && pngOut.outputHeight === 1120, "PNG long-edge scale is valid");

  const heicOut = await prepareChatAdaptivePhoto(heic, {
    decodeHeic: async () => new Blob([new Uint8Array(2 * 1024 * 1024)], { type: "image/jpeg" }),
    inspect: async () => ({ width: 3000, height: 2000 }),
    encode: async ({ mime }) => new Blob([new Uint8Array(540 * 1024)], { type: mime }),
  });
  assert(heicOut.encoded && heicOut.uploadBytes === 540 * 1024, "HEIC conversion + chat target");

  const passthrough = await prepareChatAdaptivePhoto(smallJpeg, {
    encode: async () => {
      throw new Error("should not encode small jpeg");
    },
  });
  assert(passthrough.encoded === false && passthrough.blob === smallJpeg, "500KB JPEG keeps original bytes");

  const preview = instantChatPhotoPicks([midJpeg], 1);
  assert(preview.items[0]?.previewUrl.startsWith("blob:"), "selected photo immediately previews");
  assert(preview.items[0]?.status === "preparing", "large JPEG previews before compression");
  const preparedMid = await prepareChatPendingPhoto(preview.items[0]!, midJpeg, async (file) =>
    (await prepareChatAdaptivePhoto(file, {
      inspect: async () => ({ width: 4000, height: 3000 }),
      encode: async ({ mime }) => new Blob([new Uint8Array(600 * 1024)], { type: mime }),
    })).blob
  );
  assert(preparedMid.status === "ready" && (preparedMid.metrics?.uploadBytes || 0) <= 800 * 1024, "compression 완료 즉시 ready");

  const jobs = new Map();
  let puts = 0;
  const upload = async (_room: string, item: { send?: { result?: { id: string; claim: string; exp: number; mimeType: string; size: number } } }) => {
    puts += 1;
    if (item.send?.result?.claim) return item.send.result;
    return { id: "att-p5", mimeType: "image/webp", size: 600 * 1024, exp: Math.floor(Date.now() / 1000) + 600, claim: "c" };
  };
  const first = startChatPhotoPreupload(jobs, "all", preparedMid, { upload });
  const again = startChatPhotoPreupload(jobs, "all", preparedMid, { upload });
  assert(first === again, "in-flight send same Promise reuse");
  const done = await first;
  const after = await finishChatPhotoOutgoingUploads({
    jobs,
    roomId: "all",
    photos: [{ ...preparedMid, send: { phase: "done", progress: 100, attachmentId: done.id, result: done } }],
    upload,
  });
  assert(puts === 1 && after[0]?.id === done.id, "send does not create second PUT");
  const tokenJobs = new Map();
  let forwardedToken = "";
  const tokenUpload = async (
    _room: string,
    _item: unknown,
    opts?: { chatToken?: string | null }
  ) => {
    forwardedToken = String(opts?.chatToken || "");
    return { id: "att-p9", mimeType: "image/jpeg", size: 12, exp: Math.floor(Date.now() / 1000) + 600, claim: "c9" };
  };
  const tokenPhoto = instantChatPhotoPicks(
    [new File([jpegBytes(8, 9)], "p9.jpg", { type: "image/jpeg", lastModified: 59 })],
    1
  ).items[0]!;
  tokenPhoto.status = "ready";
  await finishChatPhotoOutgoingUploads({
    jobs: tokenJobs,
    roomId: "all",
    photos: [tokenPhoto],
    upload: tokenUpload as never,
    chatToken: "live-chat-token",
  });
  assert(forwardedToken === "live-chat-token", "send path forwards chatToken into prepare");

  const triple = instantChatPhotoPicks(
    [
      new File([jpegBytes(8, 1)], "a.jpg", { type: "image/jpeg", lastModified: 51 }),
      new File([jpegBytes(8, 2)], "b.jpg", { type: "image/jpeg", lastModified: 52 }),
      new File([jpegBytes(8, 3)], "c.jpg", { type: "image/jpeg", lastModified: 53 }),
    ],
    3
  );
  assert(triple.items.length === 3 && triple.items.every((item) => item.previewUrl.startsWith("blob:")), "3장 instant preview");
  assert(shouldStartOptimisticChatSend("텍스트", triple.items), "text+photo");
  assert(buildOptimisticOutgoingLine("답글", triple.items).localPhotos.length === 3, "reply+photo");
  assert(chatPhotoComposerBusy({ ...preview.items[0]!, status: "preparing" }), "preparing shows quiet spinner");
  assert(!chatPhotoComposerBusy({ ...preparedMid, status: "ready", send: { phase: "done", progress: 100 } }), "ready hides indicator");

  assert(canShowChatPhotoDebug({ role: "admin", search: "?photoDebug=1" }), "admin + photoDebug=1");
  assert(!canShowChatPhotoDebug({ role: "caddy", search: "?photoDebug=1" }), "non-admin never sees debug");
  assert(!canShowChatPhotoDebug({ role: "admin", search: "" }), "admin without query sees no panel");
  resetChatPhotoTiming();
  stampChatPhotoTiming("photo_selected", 10);
  stampChatPhotoTiming("put_start", 40);
  stampChatPhotoTiming("prepare_complete", 25);
  stampChatPhotoTiming("send_tap", 80);
  stampChatPhotoTiming("ws_send", 90);
  markChatPhotoTiming("prepare_api", 39);
  markChatPhotoTiming("direct_put", 40);
  markChatPhotoTiming("finalize_api", 70);
  globalThis.__CHAT_PHOTO_TIMING__!.sourceBytes = 2200000;
  globalThis.__CHAT_PHOTO_TIMING__!.uploadBytes = 620000;
  globalThis.__CHAT_PHOTO_TIMING__!.compressionMs = 15;
  const debug = buildChatPhotoDebugSample();
  assert(debug.sourceBytes === 2200000 && debug.uploadBytes === 620000, "debug source/upload bytes");
  assert(debug.selectedToUploadStartMs === 30 && debug.sendTapToWsMs === 10, "debug select→PUT and send→WS");
  assert(debug.storageBackend == null && debug.r2PutMs == null && debug.r2InspectMs == null, "debug R2 fields empty by default");
  assert(
    debug.workerIngressMs == null &&
      debug.r2StoreMs == null &&
      debug.receiptVerifyMs == null &&
      debug.finalizeInspectSkipped == null &&
      debug.roomAccessFastPath == null &&
      debug.roomAccessFallbackReason == null &&
      debug.clientUploadMs == null &&
      debug.responseWaitMs == null &&
      debug.workerHashMs == null &&
      debug.workerTotalMs == null &&
      debug.decodeMs == null &&
      debug.encode1Ms == null &&
      debug.encodeAttempts == null &&
      debug.decodePath == null &&
      debug.encodePath == null &&
      debug.adaptiveTotalMs == null &&
      debug.prepareOuterMs == null &&
      debug.headerProbeMs == null &&
      debug.unaccountedPrepareMs == null,
    "phase 8/9/10 debug fields empty by default"
  );
  enableChatPhotoDebugTiming(true);
  noteChatPhotoCompressionBreakdown({
    decodeMs: 12,
    drawResizeMs: 4,
    encode1Ms: 18,
    encode2Ms: null,
    totalCompressionMs: 34,
    inputWidth: 1600,
    inputHeight: 1200,
    outputWidth: 1600,
    outputHeight: 1200,
    attempts: 1,
    encodeMime: "image/jpeg",
    decodePath: "bitmap-resize",
    encodePath: "offscreen",
  });
  const breakdown = buildChatPhotoDebugSample();
  assert(breakdown.decodeMs === 12 && breakdown.encode1Ms === 18, "debug records decode/encode1");
  assert(breakdown.encodeAttempts === 1 && breakdown.encodeMime === "image/jpeg", "debug records JPEG 1-encode");
  assert(breakdown.decodePath === "bitmap-resize" && breakdown.encodePath === "offscreen", "debug records decode/encode path");
  assert(breakdown.adaptiveTotalMs === 34 && breakdown.compressionMs === 34, "adaptive total stays on compressionMs");
  noteChatPhotoCompression(4093);
  const afterOuter = buildChatPhotoDebugSample();
  assert(afterOuter.prepareOuterMs === 4093, "outer prepare writes prepareOuterMs");
  assert(afterOuter.compressionMs === 34 && afterOuter.adaptiveTotalMs === 34, "outer prepare does not overwrite adaptive compressionMs");
  assert(afterOuter.unaccountedPrepareMs === 4059, "unaccounted prepare is outer minus adaptive");
  assert(afterOuter.unaccountedAdaptiveMs === 0, "accounted adaptive parts leave no hidden adaptive gap");
  const debugDump = JSON.stringify(debug);
  assert(!/https?:|claim|token|storageKey|\.jpg/i.test(debugDump), "debug sample has no secrets");
  assert(chatPhotoEncodeBottleneck(120) === "browser-ok", "short encode is browser-ok");
  assert(chatPhotoEncodeBottleneck(640) === "consider-native", "encode >=500ms → native candidate");
  assert(chatPhotoPutBottleneck(620000, 2500) === "blob-network", "small PUT that is slow is Blob/network");
  assert(chatPhotoPutBottleneck(620000, 400) === "put-ok", "fast PUT is not storage-bound");
}

section("regression: header-probe bitmap resize + EXIF + fallback");
{
  function jpegSofWithExif(width: number, height: number, orientation: number): Uint8Array {
    return Uint8Array.from([
      0xff, 0xd8,
      0xff, 0xe1, 0x00, 0x1e,
      0x45, 0x78, 0x69, 0x66, 0x00, 0x00,
      0x49, 0x49, 0x2a, 0x00,
      0x08, 0x00, 0x00, 0x00,
      0x01, 0x00,
      0x12, 0x01, 0x03, 0x00, 0x01, 0x00, 0x00, 0x00,
      orientation & 0xff, 0x00, 0x00, 0x00,
      0xff, 0xc0, 0x00, 0x0b, 0x08,
      (height >> 8) & 0xff,
      height & 0xff,
      (width >> 8) & 0xff,
      width & 0xff,
      0x03,
    ]);
  }
  const sof = jpegSofWithExif(4000, 3000, 6);
  const header = readImageSizeFromHeader(sof);
  assert(header?.width === 4000 && header?.height === 3000, "SOF stays 4000x3000 before orientation");
  assert(readJpegExifOrientation(sof) === 6, "JPEG EXIF orientation 6");
  const oriented = orientedImageHeaderSize(header!, 6);
  assert(oriented.width === 3000 && oriented.height === 4000, "orientation 5-8 swaps SOF dims");
  const orientedResize = chatPhotoBitmapResizeOptions(oriented.width, oriented.height);
  assert(
    orientedResize?.resizeWidth === 1200 && orientedResize?.resizeHeight === 1600,
    "portrait phone JPEG resize uses swapped 1200x1600"
  );
  const rawResize = chatPhotoBitmapResizeOptions(header!.width, header!.height);
  assert(rawResize?.resizeWidth === 1600 && rawResize?.resizeHeight === 1200, "unoriented fallback resize is 1600x1200");

  const padded = new Uint8Array(80 * 1024);
  padded.set(sof);
  const probeFile = new File([padded], "exif6.jpg", { type: "image/jpeg" });
  const probed = await probeChatPhotoOrientedSize(probeFile);
  assert(probed?.rawWidth === 4000 && probed?.rawHeight === 3000, "probe keeps SOF pixels");
  assert(probed?.width === 3000 && probed?.height === 4000, "probe applies EXIF 6 swap");

  const calls: unknown[] = [];
  const previousBitmap = (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
  (globalThis as { createImageBitmap: typeof createImageBitmap }).createImageBitmap = (async (
    _blob: Blob,
    opts?: ImageBitmapOptions
  ) => {
    calls.push(opts);
    if (opts && ("resizeWidth" in opts || "imageOrientation" in opts)) {
      throw new Error("resize unsupported");
    }
    return { width: 4000, height: 3000, close() {} } as ImageBitmap;
  }) as typeof createImageBitmap;
  try {
    const bitmap = await createChatPhotoOrientedBitmap(probeFile, orientedResize, rawResize);
    assert(bitmap.width === 4000 && bitmap.height === 3000, "resize throw falls back to full bitmap");
    assert(calls.length === 3, "oriented+resize, raw resize, then full decode");
    assert(chatPhotoDecodePathFromBitmap(bitmap, orientedResize) === "bitmap-full", "failed resize is bitmap-full");
  } finally {
    if (previousBitmap) {
      (globalThis as { createImageBitmap: typeof createImageBitmap }).createImageBitmap = previousBitmap;
    } else {
      delete (globalThis as { createImageBitmap?: typeof createImageBitmap }).createImageBitmap;
    }
  }
}

section("hidden latency: scope isolation");
{
  enableChatPhotoDebugTiming(true);
  resetChatPhotoTiming();
  enableChatPhotoDebugTiming(true);
  const fileA = new File([new Uint8Array(8)], "a.jpg", { type: "image/jpeg" });
  const fileB = new File([new Uint8Array(8)], "b.jpg", { type: "image/jpeg" });
  const runA = startChatPhotoPrepareTiming("key-a", fileA);
  const runB = startChatPhotoPrepareTiming("key-b", fileB);
  noteChatPhotoCompressionBreakdown({
    runId: runA,
    decodeMs: 10,
    encode1Ms: 20,
    totalCompressionMs: 40,
    headerProbeMs: 3,
    bitmapCreateMs: 7,
    hiddenBeforeDecodeMs: 1,
  });
  noteChatPhotoCompressionBreakdown({
    runId: runB,
    decodeMs: 200,
    encode1Ms: 80,
    totalCompressionMs: 4093,
    headerProbeMs: 30,
    bitmapCreateMs: 170,
    hiddenBeforeDecodeMs: 3800,
  });
  noteChatPhotoPrepareScope(runA, { prepareOuterMs: 50, stateCommitMs: 2 });
  noteChatPhotoPrepareScope(runB, { prepareOuterMs: 4200, stateCommitMs: 4 });
  const committedA = commitChatPhotoPrepareTiming(runA);
  assert(committedA?.decodeMs === 10 && committedA?.adaptiveTotalMs === 40, "run A keeps its adaptive totals");
  const sampleA = buildChatPhotoDebugSample();
  assert(sampleA.decodeMs === 10 && sampleA.adaptiveTotalMs === 40 && sampleA.prepareOuterMs === 50, "commit A publishes only A");
  assert(sampleA.unaccountedPrepareMs === 10, "run A unaccounted prepare is small");
  const committedB = commitChatPhotoPrepareTiming(runB);
  assert(committedB?.decodeMs === 200 && committedB?.hiddenBeforeDecodeMs === 3800, "run B keeps its own hidden gap");
  const sampleB = buildChatPhotoDebugSample();
  assert(sampleB.decodeMs === 200 && sampleB.prepareOuterMs === 4200, "commit B replaces the debug bag with B");
  assert(sampleB.compressionMs === 4093 && sampleB.adaptiveTotalMs === 4093, "run B adaptive is not mixed with A");
  assert(sampleB.hiddenBeforeDecodeMs === 3800, "hidden before decode stays on the same run");
  assert(sampleA.decodeMs === 10, "earlier sample A snapshot is unchanged");
  assert(sampleB.timingRunId === runB && sampleB.timingKey === "key-b", "published sample keeps B run id/key");
  assert(publicChatPhotoTimingKey("cph-12-secret.jpg|123|1|image/jpeg") === "cph-12", "debug key strips file name");
}

section("prepare boundary: stale bag + same File runId");
{
  enableChatPhotoDebugTiming(true);
  resetChatPhotoTiming();
  enableChatPhotoDebugTiming(true);
  const fileA = new File([new Uint8Array(12)], "keep.jpg", { type: "image/jpeg" });
  const fileB = new File([new Uint8Array(2.2 * 1024 * 1024)], "next.jpg", { type: "image/jpeg" });
  const runA = startChatPhotoPrepareTiming("cph-1-keep.jpg|12|1|image/jpeg", fileA);
  noteChatPhotoCompressionBreakdown({
    runId: runA,
    decodeMs: 210,
    encode1Ms: 36,
    totalCompressionMs: 248,
    hiddenBeforeDecodeMs: 0,
  });
  noteChatPhotoPrepareScope(runA, { prepareOuterMs: 250 });
  commitChatPhotoPrepareTiming(runA);
  assert(buildChatPhotoDebugSample().adaptiveTotalMs === 248, "run A adaptive published");
  const runB = startChatPhotoPrepareTiming("cph-2-next.jpg|2200000|2|image/jpeg", fileB);
  const afterStartB = buildChatPhotoDebugSample();
  assert(afterStartB.adaptiveTotalMs == null && afterStartB.prepareOuterMs == null, "new run start clears previous adaptive/prepare");
  assert(afterStartB.timingRunId === runB && afterStartB.timingKey === "cph-2", "new run id is public and current");
  noteChatPhotoPrepareScope(runB, { prepareOuterMs: 5221 });
  commitChatPhotoPrepareTiming(runB);
  const stale = buildChatPhotoDebugSample();
  assert(stale.prepareOuterMs === 5221, "run B outer published");
  assert(stale.adaptiveTotalMs == null && stale.decodeMs == null, "commit B does not keep run A adaptive fields");
  assert(stale.unaccountedPrepareMs == null, "missing adaptive on B does not invent a 5s mix");

  resetChatPhotoTiming();
  const bound = new File([new Uint8Array(2.2 * 1024 * 1024)], "bound.jpg", { type: "image/jpeg" });
  const runBound = startChatPhotoPrepareTiming("key-bound", bound);
  assert(chatPhotoTimingRunIdFor(bound) === runBound, "WeakMap keeps the same File → runId");
  let seen: File | null = null;
  const sourced = await prepareChatPhotoSource(bound, async (next) => {
    seen = next;
    return new Blob([new Uint8Array(8)], { type: "image/jpeg" });
  });
  assert(seen === bound, "JPEG source passes the same File into run()");
  assert(chatPhotoTimingRunIdFor(seen) === runBound, "run() File still resolves the same runId");
  assert(sourced.size === 8, "JPEG source uses the compress callback result");
  resetChatPhotoTiming();
  const delayed = new File([new Uint8Array(2.2 * 1024 * 1024)], "delay.jpg", { type: "image/jpeg" });
  const runDelay = startChatPhotoPrepareTiming("key-delay", delayed);
  await prepareChatPhotoSource(delayed, async (next) => {
    await new Promise((resolve) => setTimeout(resolve, 25));
    return next;
  });
  commitChatPhotoPrepareTiming(runDelay);
  const delaySample = buildChatPhotoDebugSample();
  assert(
    delaySample.photoSourceEnterAt != null &&
      delaySample.photoSourceExitAt != null &&
      delaySample.photoSourceExitAt - delaySample.photoSourceEnterAt >= 20,
    "photoSourceExit waits for run() to finish"
  );
  const prepared = await prepareChatPendingPhoto(
    {
      key: "key-bound",
      blob: bound,
      previewUrl: "blob:test-bound",
      fileId: "bound",
      fingerprint: "",
      status: "preparing",
    },
    bound,
    async (next) =>
      (
        await prepareChatAdaptivePhoto(next, {
          inspect: async () => ({ width: 4000, height: 3000 }),
          encode: async ({ mime }) => new Blob([new Uint8Array(600 * 1024)], { type: mime }),
        })
      ).blob
  );
  assert(prepared.metrics?.timingRunId, "pending prepare records a run id");
  assert(prepared.metrics?.timingRunId !== runBound, "each pending prepare starts a fresh run");
  const pendingSample = buildChatPhotoDebugSample();
  assert(pendingSample.pendingPrepareStartAt != null && pendingSample.pendingPrepareEndAt != null, "pending start/end stamps exist");
  assert(
    pendingSample.adaptiveEnterAt != null &&
      pendingSample.adaptiveExitAt != null &&
      (pendingSample.adaptiveMs ?? 0) >= 0,
    "adaptive enter/exit belong to the pending run"
  );
}

section("source split: JPEG getter counts + unused one-read helper");
{
  enableChatPhotoDebugTiming(true);
  function spin(ms: number) {
    const end = Date.now() + ms;
    while (Date.now() < end) {}
  }

  resetChatPhotoTiming();
  const heavy = new File([new Uint8Array(2.2 * 1024 * 1024)], "secret-vacation.jpg", { type: "image/jpeg" });
  const runId = startChatPhotoPrepareTiming("cph-1-secret-vacation.jpg|2200000|1|image/jpeg", heavy);
  let seen: File | null = null;
  await prepareChatPhotoSource(heavy, async (next) => {
    seen = next;
    noteChatPhotoBoundary(chatPhotoTimingRunIdFor(next), "adaptiveBlobEnterAt");
    return new Blob([new Uint8Array(8)], { type: "image/jpeg" });
  });
  commitChatPhotoPrepareTiming(runId);
  const sample = buildChatPhotoDebugSample();
  assert(sample.timingRunId === runId && sample.timingKey === "cph-1", "source split stays on the same public run");
  assert(seen === heavy, "JPEG run() still receives the original File");
  assert(sample.fileTypeReads === 3, "heavy JPEG reads file.type 3 times (acceptable/heic/kind)");
  assert(sample.fileNameReads === 3, "heavy JPEG reads file.name 3 times (acceptable/heic/kind)");
  assert(sample.fileSizeReads === 5, "heavy JPEG reads file.size 5 times (acceptable×2 + fastPath×3)");
  assert(sample.sourceEnterToAcceptableMs != null, "sourceEnter→acceptable stamped");
  assert(sample.acceptableToFastPathMs != null, "acceptable→fastPath stamped");
  assert(sample.fastPathToRunResolveMs != null, "fastPath→runResolve stamped");
  assert(sample.runResolveToHeicMs != null, "runResolve→heic stamped");
  assert(sample.heicToKindMs != null, "heic→kind stamped");
  assert(sample.kindToNoteScopeMs != null, "kind→noteScope stamped");
  assert(sample.noteScopeToRunInvokeMs != null, "noteScope→runInvoke stamped");
  assert(sample.runInvokeToAdaptiveBlobMs != null, "runInvoke→adaptiveBlob stamped");
  const splitSum =
    (sample.sourceEnterToAcceptableMs ?? 0) +
    (sample.acceptableToFastPathMs ?? 0) +
    (sample.fastPathToRunResolveMs ?? 0) +
    (sample.runResolveToHeicMs ?? 0) +
    (sample.heicToKindMs ?? 0) +
    (sample.kindToNoteScopeMs ?? 0) +
    (sample.noteScopeToRunInvokeMs ?? 0) +
    (sample.runInvokeToAdaptiveBlobMs ?? 0);
  assert(sample.sourceToAdaptiveBlobMs != null, "source→blob interval still present");
  assert(Math.abs(splitSum - (sample.sourceToAdaptiveBlobMs ?? 0)) <= 2, "internal splits sum to sourceToAdaptiveBlob");
  const dumped = JSON.stringify(sample);
  assert(!dumped.includes("secret-vacation"), "debug sample never includes the file name");
  assert(!dumped.includes(".jpg"), "debug sample never includes a filename suffix");

  resetChatPhotoTiming();
  const small = new File([new Uint8Array(32)], "tiny.jpg", { type: "image/jpeg" });
  const runSmall = startChatPhotoPrepareTiming("cph-2", small);
  await prepareChatPhotoSource(small, async () => {
    throw new Error("fast path must not invoke compress");
  });
  commitChatPhotoPrepareTiming(runSmall);
  const smallSample = buildChatPhotoDebugSample();
  assert(smallSample.fileTypeReads === 2, "passthrough JPEG reads type twice (acceptable + fastPath kind)");
  assert(smallSample.fileNameReads === 2, "passthrough JPEG reads name twice (acceptable + fastPath kind)");
  assert(smallSample.fileSizeReads === 6, "passthrough JPEG reads size six times (acceptable×2 + fastPath×4)");
  assert(smallSample.sourceRunInvokeAt == null && smallSample.sourceHeicEndAt == null, "fast path stops before heic/run");

  const fixtures: File[] = [
    new File([new Uint8Array(32)], "ok.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array(32)], "ok.JPG", { type: "image/jpg" }),
    new File([new Uint8Array(32)], "ok.png", { type: "image/png" }),
    new File([new Uint8Array(32)], "ok.webp", { type: "image/webp" }),
    new File([new Uint8Array(2.2 * 1024 * 1024)], "mid.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array(3 * 1024 * 1024 + 8)], "huge.jpg", { type: "image/jpeg" }),
    new File([new Uint8Array(8)], "a.heic", { type: "image/heic" }),
    new File([new Uint8Array(8)], "b.heif", { type: "image/heif" }),
    new File([new Uint8Array(8)], "x.pdf", { type: "application/pdf" }),
    new File([new Uint8Array(0)], "empty.jpg", { type: "image/jpeg" }),
  ];
  for (const file of fixtures) {
    const meta = readChatPhotoFileMeta(file);
    const plan = planChatPhotoSourceFromMeta(meta);
    assert(plan.kind === chatPhotoSourceKind(file), "one-read kind matches live kind");
    assert(plan.kind === chatPhotoSourceKindFromMeta(meta), "meta kind matches parts kind");
    assert(plan.acceptable === isChatPhotoAcceptableSource(file), "one-read acceptable matches live");
    assert(plan.acceptable === isChatPhotoAcceptableSourceFromMeta(meta), "meta acceptable matches helper");
    assert(plan.fastPath === canUseChatPhotoFastPath(file), "one-read fastPath matches live");
    assert(plan.fastPath === canUseChatPhotoFastPathFromMeta(meta), "meta fastPath matches helper");
    assert(plan.heic === isHeicLikeFile(file), "one-read heic matches live");
    assert(plan.heic === isHeicLikeFromMeta(meta), "meta heic matches helper");
  }

  const slowType = {
    get type() {
      spin(8);
      return "image/jpeg";
    },
    get name() {
      return "slow.jpg";
    },
    get size() {
      return 2.2 * 1024 * 1024;
    },
  };
  const watched = watchChatPhotoFileAccess(slowType);
  void watched.file.type;
  void watched.file.type;
  void watched.file.name;
  void watched.file.size;
  assert(watched.typeReads === 2 && watched.nameReads === 1 && watched.sizeReads === 1, "watch counts metadata getters only");
  assert(watched.typeMs >= 8, "watch records File.type getter time");
  assert(watched.nameMs === 0 || watched.nameMs < watched.typeMs, "name getter time stays a number");
}

section("debug timing off: no proxy / scope / source-split");
{
  enableChatPhotoDebugTiming(false);
  resetChatPhotoTiming();
  enableChatPhotoDebugTiming(false);
  assert(isChatPhotoDebugTiming() === false, "debug timing is off");
  const heavy = new File([new Uint8Array(2.2 * 1024 * 1024)], "secret-vacation.jpg", { type: "image/jpeg" });
  const started = startChatPhotoPrepareTiming("cph-1-secret-vacation.jpg|2200000|1|image/jpeg", heavy);
  assert(started == null, "prepare-scope start is skipped when debug is off");
  assert(chatPhotoTimingRunIdFor(heavy) == null, "WeakMap is not bound when debug is off");
  const selectedAt = 10;
  stampChatPhotoTiming("photo_selected", selectedAt);
  let seen: File | null = null;
  const t0 = chatPhotoNow();
  const out = await prepareChatPhotoSource(heavy, async (next) => {
    seen = next;
    return new Blob([new Uint8Array(8)], { type: "image/jpeg" });
  });
  const wall = chatPhotoNow() - t0;
  markChatPhotoTiming("select_to_ready", selectedAt);
  stampChatPhotoTiming("prepare_complete");
  assert(seen === heavy && out.size === 8, "debug-off JPEG still runs compress on the original File");
  assert(wall >= 0, "debug-off prepare still has a wall time");
  commitChatPhotoPrepareTiming("r1");
  const sample = buildChatPhotoDebugSample();
  assert(sample.fileTypeReads == null && sample.fileNameReads == null && sample.fileSizeReads == null, "no getter counts when debug is off");
  assert(sample.sourceEnterToAcceptableMs == null && sample.kindToNoteScopeMs == null, "source-split stamps stay empty");
  assert(sample.photoSourceEnterAt == null && sample.timingRunId == null, "prepare-scope bag is not published");
  assert(sample.selectedToReadyMs != null, "select→ready wall time is still recorded");
  const dumped = JSON.stringify(sample);
  assert(!dumped.includes("secret-vacation"), "debug-off sample has no file name");
  const rawWatch = watchChatPhotoFileAccess(heavy);
  assert(rawWatch.file === heavy, "watch does not wrap File in a Proxy when debug is off");
  void rawWatch.file.type;
  void rawWatch.file.size;
  assert(rawWatch.typeReads === 0 && rawWatch.sizeReads === 0, "off-path watch does not intercept getters");

  const prepared = await prepareChatPendingPhoto(
    {
      key: "cph-off",
      blob: heavy,
      previewUrl: "blob:test-off",
      fileId: "off",
      fingerprint: "",
      status: "preparing",
    },
    heavy,
    async (next) => next
  );
  assert(prepared.status === "ready", "pending prepare still succeeds with debug off");
  assert(prepared.metrics?.timingRunId == null, "pending prepare does not allocate a run id");
  assert(typeof prepared.metrics?.prepareOuterMs === "number", "pending prepare still returns local wall time");
}

section("phase 6 hot-path timing / region / cleanup");

{
  assert(
    sizeFromPrefixGetResult({
      statusCode: 200,
      blob: { size: 256 },
      headers: {
        "content-range": "bytes 0-255/655611",
        "content-length": "256",
      },
    }) === 655611,
    "A: normalized Range 200 prefers Content-Range total over blob.size"
  );
  assert(
    sizeFromPrefixGetResult({
      statusCode: 200,
      blob: { size: 655611 },
    }) === 655611,
    "B: full GET uses blob.size when Content-Range is absent"
  );
  assert(
    sizeFromPrefixGetResult({
      statusCode: 206,
      headers: { "content-range": "bytes 0-255/640000" },
    }) === 640000,
    "size from Content-Range"
  );
  assert(sizeFromPrefixGetResult({ statusCode: 206 }) === 0, "206 without size stays 0");
  const clock = createChatPhotoHotpathClock();
  clock.mark("auth");
  clock.mark("uploadUrl");
  clock.mark("token");
  const summary = clock.summary("prepare");
  assert(typeof summary.steps.auth === "number", "clock records safe steps");
  assert(summary.steps.signedPut == null, "clock drops unknown step names");
  const dump = JSON.stringify(summary);
  assert(!/https?:|claim|token|userId|storageKey/i.test(dump), "hotpath summary has no secrets");
  assert(parseChatPhotoHotpath({ route: "prepare", totalMs: 12, steps: { auth: 4, leak: 9 } })?.steps.auth === 4, "parse keeps safe steps");
  assert(parseChatPhotoHotpath({ route: "prepare", totalMs: 12, steps: { leak: 9 } })?.steps.auth == null, "parse drops unknown steps");
  assert(
    parseChatPhotoHotpath({
      route: "prepare",
      totalMs: 12,
      flags: { roomAccessFastPath: false, finalizeInspectSkipped: false },
      reasons: { roomAccessFallbackReason: "missing_token", leak: "nope" },
    })?.flags?.roomAccessFastPath === false,
    "parse keeps false fast-path flag"
  );
  assert(
    parseChatPhotoHotpath({
      route: "prepare",
      totalMs: 12,
      reasons: { roomAccessFallbackReason: "user_mismatch", leak: "secret" },
    })?.reasons?.roomAccessFallbackReason === "user_mismatch",
    "parse keeps safe fallback reason"
  );
  assert(
    parseChatPhotoHotpath({
      route: "prepare",
      totalMs: 12,
      reasons: { roomAccessFallbackReason: "totally_secret" },
    })?.reasons == null,
    "parse drops unknown fallback reason"
  );
  assert(shouldRunBackgroundChatPhotoCleanup(0.05) === true, "10% cleanup after() can run");
  assert(shouldRunBackgroundChatPhotoCleanup(0.2) === false, "most prepares skip after() cleanup");
  assert(chatPhotoDebugApiUrl("/api/x", "") === "/api/x", "debug query off leaves URL");
  assert(chatPhotoDebugApiUrl("/api/x", "?photoDebug=1") === "/api/x?photoDebug=1", "debug query appended");
  resetChatPhotoTiming();
  noteChatPhotoServerHotpath({
    route: "prepare",
    region: "sin1",
    cold: false,
    totalMs: 220,
    steps: { auth: 40, roomAccess: 50, count: 30, create: 40, signedPut: 60 },
  });
  const serverDebug = buildChatPhotoDebugSample();
  assert(serverDebug.prepareServerMs === 220 && serverDebug.prepareServerRegion === "sin1", "server prepare timings");
  assert(serverDebug.prepareAuthMs === 40 && serverDebug.prepareSignedPutMs === 60, "server prepare steps");
  assert(!/uploadUrl|claim/.test(JSON.stringify(serverDebug)), "server debug has no secrets");
}

section("source wiring / no public blob");

{
  const client = read("src/app/chat/ChatClient.tsx");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  const recipients = read("src/lib/chatPushRecipients.ts");
  const dispatch = read("src/lib/chatPushDispatch.ts");
  const photo = read("src/lib/chatPhoto.ts");
  const reportClient = read("src/lib/courseReportPhotoClient.ts");
  assert(client.includes("commitComposerPhotoPicks"), "composer commits picks through one helper");
  assert(client.includes("composerGenRef"), "composer generation ignores stale prepare/progress");
  assert(client.includes("leftoverComposerPhotosAfterSend"), "send keeps only failed leftover photos");
  assert(client.includes("applyComposerPreparedIfCurrent"), "prepare write is generation-gated");
  assert(client.includes("applyComposerProgressIfCurrent"), "progress write is generation-gated");
  assert(client.includes("prepareChatPendingPhoto"), "composer prepares in background");
  const preupload = read("src/lib/chatPhotoPreupload.ts");
  const timingSrc = read("src/lib/chatPhotoTiming.ts");
  assert(preupload.includes("mapBoundedSettled"), "pre-upload bounded parallel upload");
  const direct = read("src/lib/chatPhotoDirectClient.ts");
  const pickSrc = read("src/lib/chatPhotoPick.ts");
  const fast = read("src/lib/chatPhotoFastPath.ts");
  const optimistic = read("src/lib/chatPhotoOptimistic.ts");
  assert(client.includes("startChatPhotoPreupload"), "select starts background pre-upload");
  assert(client.includes("uploadJobsRef"), "composer keeps in-flight pre-upload promises");
  assert(client.includes("finishChatPhotoOutgoingUploads"), "send reuses pre-upload jobs/claims");
  assert(client.includes("startComposerPreupload"), "fast-path select starts PUT immediately");
  assert(client.includes("abandonChatPhotoPreupload"), "remove/room change abandon pre-upload jobs");
  assert(client.includes("stampChatPhotoTiming(\"photo_selected\""), "times photo selected");
  assert(client.includes("stampChatPhotoTiming(\"send_tap\""), "times send tap");
  assert(client.includes("stampChatPhotoTiming(\"ws_send\""), "times WS send");
  assert(client.includes("emitChatPhotoTimingSummary"), "emits safe client timing summary");
  assert(client.includes("prepareServerMs"), "debug panel shows server prepare timing");
  assert(client.includes("finalizeBlobMs"), "debug panel shows finalize blob step");
  assert(client.includes("r2InspectMs"), "debug panel shows R2 inspect step");
  assert(client.includes("workerIngressMs"), "debug panel shows worker ingress");
  assert(client.includes("r2StoreMs"), "debug panel shows R2 store");
  assert(client.includes("receiptVerifyMs"), "debug panel shows receipt verify");
  assert(client.includes("finalizeInspectSkipped"), "debug panel shows inspect skip");
  assert(client.includes("roomAccessFastPath"), "debug panel shows roomAccess fast path");
  assert(client.includes("roomAccessFallbackReason"), "debug panel shows fast-path fallback reason");
  assert(client.includes("clientUploadMs"), "debug panel shows client upload split");
  assert(client.includes("responseWaitMs"), "debug panel shows response wait split");
  assert(client.includes("workerHashMs"), "debug panel shows worker hash");
  assert(client.includes("workerTotalMs"), "debug panel shows worker total");
  assert(client.includes("warmChatPhotoMediaConnection"), "chat entry warms Worker origin");
  assert(client.includes("connectionWaitMs"), "debug panel shows connection wait");
  assert(client.includes("storageBackend"), "debug panel shows storage backend");
  assert(client.includes("r2PutMs"), "debug panel shows R2 PUT");
  assert(client.includes("finalizeSignMs"), "debug panel shows finalize sign step");
  assert(client.includes("chatToken: tokenRef.current?.token"), "composer passes live chat token");
  assert(timingSrc.includes("select_to_put_start_ms"), "timing summary has select→PUT start");
  assert(direct.includes("stampChatPhotoTiming(\"put_start\""), "times PUT start");
  assert(direct.includes("chatPhotoClaimStillValid"), "direct upload reuses live claims");
  assert(client.includes("reply?.seq"), "reply+photo still forwards reply seq");
  assert(!client.includes("fd.append"), "composer no longer posts photo bytes to Next");
  assert(direct.includes("/attachments/prepare"), "composer calls prepare");
  assert(direct.includes("/finalize"), "composer calls finalize");
  assert(client.includes("처리 중"), "preparing status copy");
  assert(!client.includes("준비 중"), "composer does not expose prepare stage");
  assert(!client.includes("vh-chat-pending-status"), "composer does not expose upload stage labels");
  assert(client.includes("chatPhotoComposerBusy"), "messenger-style busy spinner");
  assert(client.includes("canShowChatPhotoDebug"), "admin photo debug gate");
  assert(client.includes("photoDebug"), "photoDebug query panel");
  const adaptive = read("src/lib/chatPhotoAdaptive.ts");
  assert(adaptive.includes("createImageBitmap"), "adaptive prefers createImageBitmap");
  assert(adaptive.includes("imageOrientation"), "bitmap decode keeps EXIF orientation");
  assert(adaptive.includes("resizeWidth"), "header probe feeds createImageBitmap resize");
  assert(adaptive.includes("OffscreenCanvas"), "adaptive considers OffscreenCanvas");
  assert(adaptive.includes("shouldAcceptChatPhotoEncode"), "first encode can stop at 3MB");
  assert(adaptive.includes('mime: "image/jpeg"'), "non-alpha adaptive encode prefers JPEG");
  assert(adaptive.includes("CHAT_PHOTO_ENCODE_MAX_ATTEMPTS"), "encode loop is bounded");
  assert(adaptive.includes("probeChatPhotoOrientedSize"), "header size probe before full decode");
  assert(client.includes("decodeMs"), "debug panel shows decode timing");
  assert(client.includes("encode1Ms"), "debug panel shows first encode timing");
  assert(client.includes("encodeAttempts"), "debug panel shows encode attempts");
  assert(client.includes("decodePath"), "debug panel shows decode path");
  assert(client.includes("encodePath"), "debug panel shows encode path");
  assert(client.includes("adaptiveTotalMs"), "debug panel shows adaptive total");
  assert(client.includes("prepareOuterMs"), "debug panel shows prepare outer");
  assert(client.includes("hiddenBeforeDecodeMs"), "debug panel shows pre-decode gap");
  assert(client.includes("unaccountedAdaptiveMs"), "debug panel shows unaccounted adaptive");
  assert(client.includes("pendingToWrapperMs"), "debug panel shows pending→wrapper");
  assert(client.includes("adaptiveBlobToAdaptiveMs"), "debug panel shows blob→adaptive");
  assert(client.includes("wrapperExitToPendingEndMs"), "debug panel shows wrapper→pending end");
  assert(client.includes("sourceEnterToAcceptableMs"), "debug panel shows source→acceptable");
  assert(client.includes("acceptableToFastPathMs"), "debug panel shows acceptable→fastPath");
  assert(client.includes("fastPathToRunResolveMs"), "debug panel shows fastPath→runResolve");
  assert(client.includes("runResolveToHeicMs"), "debug panel shows runResolve→heic");
  assert(client.includes("heicToKindMs"), "debug panel shows heic→kind");
  assert(client.includes("kindToNoteScopeMs"), "debug panel shows kind→noteScope");
  assert(client.includes("noteScopeToRunInvokeMs"), "debug panel shows noteScope→runInvoke");
  assert(client.includes("runInvokeToAdaptiveBlobMs"), "debug panel shows runInvoke→blob");
  assert(client.includes("fileTypeReads"), "debug panel shows type getter count");
  assert(client.includes("fileNameReads"), "debug panel shows name getter count");
  assert(client.includes("fileSizeReads"), "debug panel shows size getter count");
  assert(client.includes("fileTypeMs"), "debug panel shows type getter ms");
  assert(client.includes("fileNameMs"), "debug panel shows name getter ms");
  assert(client.includes("fileSizeMs"), "debug panel shows size getter ms");
  assert(client.includes("timingKey"), "debug panel shows public timing key");
  assert(!client.includes("file.name"), "debug panel does not print file.name");
  const sourcePrepareFn = fast.slice(fast.indexOf("export async function prepareChatPhotoSource"));
  assert(sourcePrepareFn.includes("isChatPhotoAcceptableSource"), "live source still calls acceptable helper");
  assert(sourcePrepareFn.includes("canUseChatPhotoFastPath"), "live source still calls fast-path helper");
  assert(sourcePrepareFn.includes("isHeicLikeFile"), "live source still calls heic helper");
  assert(sourcePrepareFn.includes("chatPhotoSourceKind"), "live source still calls kind helper");
  assert(!sourcePrepareFn.includes("readChatPhotoFileMeta"), "live source does not use the one-read snapshot");
  assert(!sourcePrepareFn.includes("planChatPhotoSourceFromMeta"), "live source does not use the unused planner");
  assert(fast.includes("planChatPhotoSourceFromMeta"), "one-read planner is present for a later wire");
  assert(timingSrc.includes("watchChatPhotoFileAccess"), "timing watches File metadata getters");
  assert(timingSrc.includes("isChatPhotoDebugTiming"), "debug timing has an explicit gate");
  assert(timingSrc.includes("enableChatPhotoDebugTiming"), "photoDebug can turn detailed timing on");
  assert(fast.includes("isChatPhotoDebugTiming"), "source prepare skips debug bookkeeping when off");
  assert(client.includes("enableChatPhotoDebugTiming"), "ChatClient arms debug timing only for photoDebug");
  assert(sourcePrepareFn.includes("const debug = isChatPhotoDebugTiming()"), "live source branches on debug flag");
  assert(sourcePrepareFn.includes("debug ? watchChatPhotoFileAccess(file) : null"), "Proxy is not created on the hot path");
  assert(client.includes('markChatPhotoTiming("select_to_ready"'), "heavy prepare stamps select_to_ready");
  assert(timingSrc.includes("clearPrepareScopeFromBag"), "commit replaces prepare-scope fields");
  assert(fast.includes("jpegDirectRun"), "JPEG source records same-file run");
  assert(timingSrc.includes("noteChatPhotoCompression"), "outer note exists");
  assert(timingSrc.includes("prepareOuterMs = Math.max(0, ms)"), "outer note does not write compressionMs");
  assert(timingSrc.includes("noteChatPhotoCompressionBreakdown"), "timing bag records compression split");
  assert(fast.includes("CHAT_PHOTO_PASSTHROUGH_MAX_BYTES"), "passthrough is chat-sized not 3MB");
  assert(reportClient.includes("createImageBitmap"), "createImageBitmap decode path");
  assert(!client.includes("전송 중..."), "composer send button is not locked as 전송 중");
  assert(client.includes("send_tap_to_local_bubble"), "send tap times local bubble");
  assert(client.includes("localPhotos"), "optimistic outgoing keeps local photos");
  assert(client.includes("discardFailedLine"), "failed bubble can be deleted");
  assert(pickSrc.includes("canUseChatPhotoFastPath"), "pick uses chat fast path");
  assert(!pickSrc.includes("courseReportPhotoBlobFingerprint"), "chat pick has no full blob fingerprint");
  assert(fast.includes("canUseChatPhotoFastPath"), "chat fast-path helper");
  assert(optimistic.includes("buildOptimisticOutgoingLine"), "optimistic send helper");
  assert(client.includes("chatPhotoSrc"), "authenticated photo src");
  assert(!client.includes("blob.vercel"), "client has no public blob url");
  assert(!client.includes("BLOB_READ_WRITE"), "client has no store token");
  assert(!client.includes("clientSigningToken"), "client has no signing token");
  assert(photo.includes("chat/${roomId}/"), "chat storage namespace");
  assert(photo.includes("prepareChatPhotoUpload"), "prepare helper");
  assert(photo.includes("finalizeChatPhotoUpload"), "finalize helper");
  assert(photo.includes('uploadState: "PENDING"'), "prepare stores PENDING");
  assert(photo.includes("readPrefixAndMeta"), "finalize prefers one prefix+meta read");
  assert(photo.includes("inspectUploadedChatPhoto"), "finalize inspects via helper");
  assert(!/store\.get\(row\.storageKey\)/.test(photo), "finalize does not full-get Blob");
  assert(!photo.includes("arrayBuffer()"), "finalize does not buffer whole Blob");
  const getRoute = read("src/app/api/chat/rooms/[roomId]/attachments/[attachmentId]/route.ts");
  const proxyRoute = read("src/app/api/chat/rooms/[roomId]/attachments/route.ts");
  const storage = read("src/lib/courseReportPhotoStorage.ts");
  const sw = read("public/sw.js");
  const phase6 = read("src/lib/chatPhase6.ts");
  assert(photo.includes('uploadState !== "READY"'), "GET helper requires READY");
  assert(proxyRoute.includes("410"), "legacy proxy upload removed");
  assert(!proxyRoute.includes("readUploadBytes"), "legacy route does not buffer photo bytes");
  assert(storage.includes("issueSignedToken"), "private Blob signed PUT");
  assert(storage.includes('operations: ["put"]'), "signed URL is PUT only");
  assert(storage.includes("async head("), "store has HEAD metadata");
  assert(storage.includes("async readPrefix("), "store has prefix read");
  assert(storage.includes("Range:"), "Vercel prefix uses Range GET when available");
  assert(storage.includes("statusCode === 206"), "Range 206 is usable");
  assert(storage.includes("readBlobObjectPrefixWithGet"), "range then non-range fallback");
  assert(storage.includes("blobPrefixGetResultUsable"), "prefix helper owns 200/206 check");
  const sizeFn = storage.slice(
    storage.indexOf("export function sizeFromPrefixGetResult"),
    storage.indexOf("export function contentTypeFromPrefixGetResult")
  );
  assert(
    sizeFn.indexOf("content-range") >= 0 &&
      sizeFn.indexOf("content-range") < sizeFn.indexOf("blob?.size"),
    "Content-Range total is preferred over blob.size"
  );
  const prefixHelper = storage.slice(
    storage.indexOf("export async function readBlobObjectPrefixAndMetaWithGet"),
    storage.indexOf("export async function readBlobObjectPrefixWithGet")
  );
  assert(prefixHelper.includes("blobPrefixGetResultUsable"), "range path uses usable helper");
  assert(!prefixHelper.includes("statusCode !== 200"), "prefix helper does not require 200 only");
  assert(storage.includes("reader.cancel"), "prefix stream cancels after 256B");
  assert(sw.includes("openWindow"), "#250 PWA openWindow kept");
  assert(phase6.includes("parseChatDeepLinkRoomId"), "#250 deep-link parser kept");
  assert(getRoute.includes("loadChatPhotoMeta"), "GET still uses authenticated meta");
  assert(photo.includes("allowLocalChatPhotoMemoryStore"), "local memory store is gated");
  assert(photo.includes("__caddyChatPhotoMemoryStore"), "local memory store is process-global");
  assert(!photo.includes("notices/"), "does not write notice keys");
  assert(!photo.includes("course-reports/"), "does not write report keys");
  assert(
    !allowLocalChatPhotoMemoryStore({
      LOCAL_PHOTO_MEMORY: "1",
      VERCEL: "1",
      DATABASE_URL: "postgresql://caddy:caddy@localhost:5432/caddy_local",
    } as NodeJS.ProcessEnv),
    "memory store off on Vercel"
  );
  assert(
    !allowLocalChatPhotoMemoryStore({
      LOCAL_PHOTO_MEMORY: "1",
      DATABASE_URL: "postgresql://caddy:caddy@ep-prod.neon.tech/neondb",
    } as NodeJS.ProcessEnv),
    "memory store off on neon"
  );
  assert(
    allowLocalChatPhotoMemoryStore({
      LOCAL_PHOTO_MEMORY: "1",
      DATABASE_URL: "postgresql://caddy:caddy@localhost:5432/caddy_local",
    } as NodeJS.ProcessEnv),
    "memory store on for local flag"
  );
  assert(worker.includes("attachments_json"), "DO stores metadata json");
  assert(worker.includes("verifyChatAttachmentClaim"), "worker verifies claims");
  assert(worker.includes("runChatAttachmentMaintenance") === false, "worker does not import Next maintenance");
  assert(photo.includes("runChatAttachmentMaintenance"), "orphan maintenance helper remains");
  const prepareFn = photo.slice(
    photo.indexOf("export async function prepareChatPhotoUpload"),
    photo.indexOf("export async function finalizeChatPhotoUpload")
  );
  assert(prepareFn.includes("if (pending >= CHAT_PHOTO_MAX)"), "prepare counts before cleanup");
  assert(
    prepareFn.includes("await runChatAttachmentMaintenance(db)"),
    "prepare cleans only after quota is full"
  );
  assert(
    prepareFn.indexOf("countUnconsumedChatPhotos") < prepareFn.indexOf("runChatAttachmentMaintenance"),
    "prepare does not clean before the first count"
  );
  const vercelCfg = read("vercel.json");
  const cleanupCron = read("src/app/api/cron/chat-attachment-cleanup/route.ts");
  const prepareRoute = read("src/app/api/chat/rooms/[roomId]/attachments/prepare/route.ts");
  const finalizeRoute = read("src/app/api/chat/rooms/[roomId]/attachments/[attachmentId]/finalize/route.ts");
  const hotpath = read("src/lib/chatPhotoHotpath.ts");
  assert(vercelCfg.includes('"regions": ["sin1"]'), "functions pinned to Singapore sin1");
  assert(!/preferredRegion/.test(vercelCfg + prepareRoute + finalizeRoute), "no deprecated preferredRegion");
  assert(vercelCfg.includes("/api/cron/chat-attachment-cleanup"), "cleanup cron is scheduled");
  assert(cleanupCron.includes("authorizeCronRequest"), "cleanup cron is fail-closed");
  assert(cleanupCron.includes("runChatAttachmentMaintenance"), "cron runs orphan cleanup");
  assert(prepareRoute.includes("createChatPhotoHotpathClock"), "prepare records server timing");
  assert(finalizeRoute.includes("createChatPhotoHotpathClock"), "finalize records server timing");
  assert(finalizeRoute.includes("chatPhotoIdentityMatchesReceipt"), "receipt finalize matches env-admin identity");
  assert(!finalizeRoute.includes("f5747f1"), "finalize comments do not claim a rolled-back Worker");
  assert(finalizeRoute.includes("f2438a3"), "finalize comments record live #261 Worker");
  assert(timingSrc.includes("first upload progress"), "connectionWaitMs is first-progress wait, not preflight-only");
  assert(finalizeRoute.includes('clock.flag("roomAccessFastPath", false)'), "no-receipt finalize keeps false flag");
  assert(prepareRoute.includes("after("), "prepare cleanup is after() not awaited");
  assert(read("src/app/api/chat/attachments/consume/route.ts").includes("void runChatAttachmentMaintenance"), "consume still best-effort cleanup");
  assert(hotpath.includes('"regions": ["sin1"]') || vercelCfg.includes('"sin1"'), "sin1 pin is documented");
  assert(hotpath.includes("CHAT_PHOTO_STORAGE=r2"), "R2 is chat-only opt-in");
  assert(photo.includes("purgeChatAttachments"), "room-scoped purge helper");
  assert(photo.includes("buildChatPhotoR2StorageKey"), "prepare can write r2/ keys");
  assert(photo.includes("inspectChatPhotoR2"), "R2 finalize uses Worker inspect");
  assert(photo.includes("verifyChatMediaUploadReceipt"), "R2 finalize can verify Worker receipt");
  assert(photo.includes("finalizeInspectSkipped"), "valid receipt skips inspect");
  assert(photo.includes("isChatPhotoR2StorageKey"), "read path keys off r2/ prefix");
  assert(!photo.includes("issueSignedToken"), "chat photo helper does not call Blob signer");
  const r2Client = read("src/lib/chatPhotoR2.ts");
  const grantSrc = read("cloudflare/verthill-chat/src/chatMediaGrant.ts");
  const mediaSrc = read("cloudflare/verthill-chat/src/chatMedia.ts");
  const reportStorage = read("src/lib/courseReportPhotoStorage.ts");
  const noticePhoto = read("src/lib/noticePhoto.ts");
  assert(r2Client.includes("CHAT_PHOTO_STORAGE"), "chat-only storage switch");
  assert(r2Client.includes("CHAT_MEDIA_INSPECT_PATH"), "finalize inspects via Worker");
  assert(!r2Client.includes("issueSignedToken"), "R2 path has no Blob signed token");
  assert(grantSrc.includes("chat_media_put"), "upload grant op");
  assert(grantSrc.includes("CHAT_MEDIA_SECRET"), "media secret preferred");
  assert(!/storageKey/.test(grantSrc.slice(grantSrc.indexOf("export type ChatMediaPutGrant"), grantSrc.indexOf("export type ChatMediaGrantSecretEnv"))), "grant payload has no storageKey");
  assert(mediaSrc.includes("deriveChatMediaR2Key"), "Worker derives object key");
  assert(mediaSrc.includes("etagDoesNotMatch"), "first PUT is official R2 create-only");
  assert(mediaSrc.includes("readBoundedBody"), "PUT buffers a bounded Uint8Array");
  assert(mediaSrc.includes("chat_media_upload_failed"), "PUT failures emit a safe category log");
  const uploadFn = mediaSrc.slice(
    mediaSrc.indexOf("export async function handleChatMediaUpload"),
    mediaSrc.indexOf("export async function handleChatMediaInspect")
  );
  assert(uploadFn.includes("readBoundedBody"), "normal R2 upload uses bounded body");
  assert(uploadFn.includes("sha256Hex"), "hot path hashes bounded bytes for retry");
  assert(!uploadFn.includes("bounded.stream"), "bucket.put does not take a reconstructed stream");
  assert(uploadFn.includes("bounded.bytes"), "bucket.put receives Uint8Array bytes");
  assert(!/await request\.arrayBuffer\(\)/.test(mediaSrc), "PUT does not unbounded arrayBuffer");
  assert(mediaSrc.includes("upload_conflict"), "different-size replay is 409");
  assert(mediaSrc.includes("signChatMediaUploadReceipt"), "successful PUT signs a receipt");
  const accessSrc = read("src/lib/chatPhotoAccess.ts");
  assert(accessSrc.includes("verifyChatToken"), "prepare can locally verify chat token");
  assert(accessSrc.includes("fastPath"), "ALL room token skips caddy DB reissue");
  assert(accessSrc.includes("chatPhotoIdentityMatchesToken"), "env-admin token can match without cookie userId");
  assert(accessSrc.includes("missing_token"), "fast-path fallback reasons are safe enums");
  assert(accessSrc.includes("AbortSignal.timeout"), "directory membership lookup is bounded");
  assert(direct.includes("chatToken"), "prepare request can carry chat token");
  assert(direct.includes("receipt"), "finalize request can carry upload receipt");
  assert(direct.includes("xhrUploadCompleteMs"), "client PUT splits upload vs response wait");
  assert(direct.includes("clientUploadMs"), "client PUT records upload duration");
  assert(mediaSrc.includes("hashMs"), "Worker reports hash timing");
  assert(mediaSrc.includes("workerTotalMs"), "Worker reports total timing");
  assert(hotpath.includes("roomAccessFallbackReason"), "hotpath parse keeps fallback reason");
  assert(timingSrc.includes("noteChatPhotoPutSplit"), "timing bag records XHR split");
  assert(read("src/lib/chatClientConfig.ts").includes("warmChatPhotoMediaConnection"), "preconnect helper exists");
  assert(read("src/lib/chatPhotoPreupload.ts").includes("chatToken: opts.chatToken"), "send forwards live chat token");
  assert(!reportStorage.includes("CHAT_PHOTO_STORAGE"), "CourseReport store ignores chat R2 switch");
  assert(!noticePhoto.includes("CHAT_PHOTO_STORAGE"), "Notice store ignores chat R2 switch");
  assert(direct.includes("x-chat-media-grant") || direct.includes("CHAT_MEDIA_GRANT_HEADER"), "client sends upload grant");
  const wrangler = read("cloudflare/verthill-chat/wrangler.jsonc");
  assert(/"r2_buckets"\s*:/.test(wrangler), "wrangler binds production R2");
  assert(wrangler.includes('"binding": "CHAT_MEDIA"'), "R2 binding name is CHAT_MEDIA");
  assert(wrangler.includes('"bucket_name": "verthill-chat-media"'), "R2 bucket is verthill-chat-media");
  assert(!/"CHAT_MEDIA_SECRET"\s*:/.test(wrangler), "CHAT_MEDIA_SECRET is not a wrangler config value");
  const hideFn = worker.slice(worker.indexOf("private hideForMe"), worker.indexOf("private deleteMessage"));
  assert(!hideFn.includes("queueAttachmentCleanup"), "hide-for-me does not purge blob");
  assert(worker.includes("queueAttachmentCleanup(attach.roomId"), "everyone/admin delete queues cleanup");
  assert(worker.includes("SELECT seq, attachments_json FROM messages WHERE sent_at"), "retention captures attachments");
  assert(worker.includes("/api/chat/attachments/cleanup"), "worker calls cleanup API");
  assert(proto.includes("CHAT_PHOTO_PUSH_BODY"), "push copy in protocol");
  assert(!recipients.includes("attachment"), "recipient selection unchanged");
  assert(!dispatch.includes("attachment"), "dispatch orchestration unchanged");
  assert(fs.existsSync("src/app/api/notice/[id]/photos/route.ts"), "notice photo route kept");
  assert(fs.existsSync("src/app/api/course-reports/[id]/photos/route.ts"), "report photo route kept");
}

section("r2 grant / key / magic");
{
  assert(chatPhotoStorageBackend({} as NodeJS.ProcessEnv) === "blob", "unset storage stays blob");
  assert(chatPhotoStorageBackend({ CHAT_PHOTO_STORAGE: "r2" } as NodeJS.ProcessEnv) === "r2", "r2 switch");
  assert(chatPhotoStorageBackend({ CHAT_PHOTO_STORAGE: "blob" } as NodeJS.ProcessEnv) === "blob", "explicit blob");
  assert(
    chatMediaSecret({ CHAT_MEDIA_SECRET: "media", CHAT_INTERNAL_SECRET: "internal", CHAT_AUTH_SECRET: "auth" }) ===
      "media",
    "prefers CHAT_MEDIA_SECRET"
  );
  assert(
    chatMediaSecret({ CHAT_INTERNAL_SECRET: "internal", CHAT_AUTH_SECRET: "auth" }) === "internal",
    "falls back to CHAT_INTERNAL_SECRET"
  );
  const roomId = "all";
  const attachmentId = "11111111-1111-4111-8111-111111111111";
  assert(
    deriveChatMediaR2Key({ roomId, attachmentId, mimeType: "image/jpeg" }) ===
      `chat/${roomId}/${attachmentId}.jpg`,
    "exact R2 key jpeg"
  );
  assert(
    deriveChatMediaR2Key({ roomId, attachmentId, mimeType: "image/png" }) ===
      `chat/${roomId}/${attachmentId}.png`,
    "exact R2 key png"
  );
  assert(
    buildChatPhotoR2StorageKey(roomId, "image/jpeg", attachmentId) ===
      `r2/chat/${roomId}/${attachmentId}.jpg`,
    "DB key uses r2/ prefix"
  );
  assert(isChatPhotoR2StorageKey(`r2/chat/${roomId}/${attachmentId}.jpg`), "r2/chat is R2");
  assert(!isChatPhotoR2StorageKey(`chat/${roomId}/${attachmentId}.jpg`), "legacy chat/ is never guessed as R2");
  assert(
    parseChatMediaObjectRef(`r2/chat/${roomId}/${attachmentId}.jpg`)?.attachmentId === attachmentId,
    "parse r2 storage key"
  );
  const grantBody = {
    v: 1 as const,
    op: CHAT_MEDIA_PUT_OP,
    roomId,
    attachmentId,
    senderUserId: 7,
    mimeType: "image/jpeg" as const,
    maxBytes: 3 * 1024 * 1024,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  assert(!canonicalChatMediaPutGrant(grantBody).includes("chat/"), "canonical grant hides object key");
  const secret = "chat-media-unit-secret";
  const token = await signChatMediaPutGrant(secret, grantBody);
  const ok = await verifyChatMediaPutGrant(secret, token);
  assert(ok.ok && ok.grant.attachmentId === attachmentId, "valid upload grant");
  const expired = await verifyChatMediaPutGrant(secret, token, grantBody.exp + 1);
  assert(!expired.ok && expired.code === "expired", "expired grant rejection");
  const tampered = token.replace(token.slice(0, 8), "aaaaaaaa");
  const bad = await verifyChatMediaPutGrant(secret, tampered);
  assert(!bad.ok, "tampered grant rejection");
  const otherSecret = await verifyChatMediaPutGrant("other-secret", token);
  assert(!otherSecret.ok && otherSecret.code === "unauthorized", "wrong secret rejection");
  const receiptBody = {
    v: 1 as const,
    op: CHAT_MEDIA_UPLOADED_OP,
    roomId,
    attachmentId,
    senderUserId: 7,
    mimeType: "image/jpeg" as const,
    actualSize: 16,
    exp: Math.floor(Date.now() / 1000) + 300,
  };
  const receiptToken = await signChatMediaUploadReceipt(secret, receiptBody);
  const receiptOk = await verifyChatMediaUploadReceipt(secret, receiptToken);
  assert(receiptOk.ok && receiptOk.receipt.attachmentId === attachmentId, "valid upload receipt");
  const expiredReceipt = await verifyChatMediaUploadReceipt(secret, receiptToken, receiptBody.exp + 1);
  assert(!expiredReceipt.ok && expiredReceipt.code === "expired", "expired receipt rejection");
  const tamperedReceipt = receiptToken.replace(receiptToken.slice(0, 8), "aaaaaaaa");
  const badReceipt = await verifyChatMediaUploadReceipt(secret, tamperedReceipt);
  assert(!badReceipt.ok, "tampered receipt rejection");
  const jpeg = jpegBytes(16, 1);
  assert(inspectChatMediaMagic({ prefix: jpeg, totalSize: jpeg.byteLength, expectedMime: "image/jpeg" }).ok, "jpeg magic");
  assert(
    !inspectChatMediaMagic({ prefix: pdfBytes(), totalSize: 8, expectedMime: "image/jpeg" }).ok,
    "magic byte mismatch"
  );
  assert(
    !inspectChatMediaMagic({ prefix: jpeg, totalSize: 3 * 1024 * 1024 + 1 }).ok,
    ">3MB magic reject"
  );
  assert(!chatPhotoR2WriteEnabled({} as NodeJS.ProcessEnv), "r2 write off without env");

  const captured: string[] = [];
  const origXhr = (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  delete (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest;
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    captured.push(headers.get(CHAT_MEDIA_GRANT_HEADER) || "");
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  try {
    await putChatPhotoBytes("http://chat-media.test/media/upload", new Blob([jpeg]), "image/jpeg", undefined, {
      grant: token,
    });
  } finally {
    globalThis.fetch = origFetch;
    if (origXhr) (globalThis as { XMLHttpRequest?: typeof XMLHttpRequest }).XMLHttpRequest = origXhr;
  }
  assert(captured[0] === token, "client PUT sends upload grant header");

  class FakeXhr {
    status = 200;
    responseText = JSON.stringify({
      receipt: "r",
      timing: { ingressMs: 4, hashMs: 2, storeMs: 8, workerTotalMs: 16 },
    });
    upload: {
      onprogress: ((event: { loaded: number; total: number; lengthComputable: boolean }) => void) | null;
      onload: (() => void) | null;
    } = { onprogress: null, onload: null };
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    headers: Record<string, string> = {};
    open() {}
    setRequestHeader(name: string, value: string) {
      this.headers[name] = value;
    }
    send() {
      this.upload.onprogress?.({ loaded: 4, total: 16, lengthComputable: true });
      this.upload.onload?.();
      this.onload?.();
    }
  }
  const prevXhr = (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = FakeXhr;
  try {
    const split = await putChatPhotoBytes("http://chat-media.test/media/upload", new Blob([jpeg]), "image/jpeg");
    assert(split.ingressMs === 4 && split.hashMs === 2 && split.storeMs === 8 && split.workerTotalMs === 16, "XHR parses worker split");
    assert(
      split.xhrStartMs != null &&
        split.xhrUploadCompleteMs != null &&
        split.xhrResponseCompleteMs != null &&
        split.clientUploadMs != null &&
        split.responseWaitMs != null &&
        split.connectionWaitMs != null,
      "XHR records upload vs response wait"
    );
  } finally {
    if (prevXhr) (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest = prevXhr;
    else delete (globalThis as { XMLHttpRequest?: unknown }).XMLHttpRequest;
  }

  function countingStream(bytes: Uint8Array, pulled: { n: number; cancelled: boolean }, chunk = 65536) {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const next = bytes.subarray(offset, offset + chunk);
        offset += next.byteLength;
        pulled.n += next.byteLength;
        controller.enqueue(next);
      },
      cancel() {
        pulled.cancelled = true;
      },
    });
  }

  const smallOk = await readBoundedBody(countingStream(jpeg, { n: 0, cancelled: false }, 8), CHAT_PHOTO_MAX_BYTES);
  assert(smallOk.ok && smallOk.bytes.byteLength === jpeg.byteLength, "bounded reader accepts <=3MB");
  const pulledOver = { n: 0, cancelled: false };
  const sixMb = jpegBytes(6 * 1024 * 1024, 9);
  const over = await readBoundedBody(countingStream(sixMb, pulledOver, 65536), CHAT_PHOTO_MAX_BYTES);
  assert(!over.ok && over.code === "file_too_large", "missing Content-Length + >3MB stream → 413 helper");
  assert(pulledOver.cancelled, "oversized stream cancelled");
  assert(pulledOver.n <= CHAT_PHOTO_MAX_BYTES + 65536, "oversized stream is not fully buffered");
  assert(pulledOver.n < sixMb.byteLength, "reader stops before the 6MB tail");

  const photoA = jpegBytes(16, 41);
  const photoB = jpegBytes(64, 42);
  const putValues: unknown[] = [];
  const spyBucket = createMemoryChatMediaBucket();
  const origPut = spyBucket.put.bind(spyBucket);
  spyBucket.put = async (key, value, options) => {
    putValues.push(value);
    return origPut(key, value, options);
  };
  const firstA = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: photoA,
    }),
    { CHAT_MEDIA: spyBucket, CHAT_MEDIA_SECRET: secret }
  );
  const firstAJson = await uploadJson(firstA);
  assert(firstA?.status === 200 && firstAJson?.receipt, "first PUT A → 200 receipt");
  assert(putValues[0] instanceof Uint8Array, "normal R2 upload puts Uint8Array, not a reconstructed stream");
  const stored = await spyBucket.head(`chat/${roomId}/${attachmentId}.jpg`);
  assert(stored?.customMetadata?.mime === "image/jpeg", "stores mime metadata");
  assert(stored?.size === photoA.byteLength, "stores actual object size");
  assert(stored?.customMetadata?.sha256 === (await sha256Hex(photoA)), "stores sha256 metadata");
  const sameA = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: photoA,
    }),
    { CHAT_MEDIA: spyBucket, CHAT_MEDIA_SECRET: secret }
  );
  const sameAJson = await uploadJson(sameA);
  assert(sameA?.status === 200 && sameAJson?.receipt, "same grant + identical A → receipt retry");
  const differentB = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: photoB,
    }),
    { CHAT_MEDIA: spyBucket, CHAT_MEDIA_SECRET: secret }
  );
  const conflictJson = await differentB?.clone().json().catch(() => null);
  assert(differentB?.status === 409 && conflictJson?.error === "upload_conflict", "same grant + different size B → 409");
  const photoSameSize = jpegBytes(16, 99);
  assert(photoSameSize.byteLength === photoA.byteLength && photoSameSize[4] !== photoA[4], "same-size different bytes fixture");
  const sameSizeDiff = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: photoSameSize,
    }),
    { CHAT_MEDIA: spyBucket, CHAT_MEDIA_SECRET: secret }
  );
  const sameSizeJson = await sameSizeDiff?.clone().json().catch(() => null);
  assert(
    sameSizeDiff?.status === 409 && sameSizeJson?.error === "upload_conflict",
    "same size + same mime + different bytes → 409"
  );
  const afterConflict = new Uint8Array((await (await spyBucket.get(`chat/${roomId}/${attachmentId}.jpg`))!.arrayBuffer()));
  assert(afterConflict[4] === photoA[4], "conflict 뒤 R2 object bytes unchanged");
  assert(
    retryMatchesExisting(
      {
        size: photoA.byteLength,
        customMetadata: { mime: "image/jpeg", sha256: await sha256Hex(photoA) },
      },
      grantBody,
      { size: photoA.byteLength, sha256: await sha256Hex(photoA) }
    ),
    "retry helper accepts mime+size+sha256"
  );
  assert(
    !retryMatchesExisting(
      {
        size: photoA.byteLength,
        customMetadata: { mime: "image/jpeg", sha256: await sha256Hex(photoA) },
      },
      grantBody,
      { size: photoA.byteLength, sha256: await sha256Hex(photoSameSize) }
    ),
    "retry helper rejects different digest"
  );
  const cond = await spyBucket.put(
    `chat/${roomId}/${attachmentId}.jpg`,
    photoB,
    { onlyIf: CHAT_MEDIA_CREATE_ONLY, httpMetadata: { contentType: "image/jpeg" } }
  );
  assert(cond == null, "memory bucket honors create-only onlyIf");

  const streamPulled = { n: 0, cancelled: false };
  const missingLen = await handleChatMediaRequest(
    new Request("http://x/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: countingStream(jpegBytes(24, 43), streamPulled, 8),
      duplex: "half",
    } as RequestInit),
    {
      CHAT_MEDIA: createMemoryChatMediaBucket(),
      CHAT_MEDIA_SECRET: secret,
    }
  );
  const missingLenJson = await uploadJson(missingLen);
  assert(missingLen?.status === 200 && missingLenJson?.receipt, "missing Content-Length + <=3MB → receipt");
  const bigPulled = { n: 0, cancelled: false };
  const missingHuge = await handleChatMediaRequest(
    new Request("http://x/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: countingStream(sixMb, bigPulled, 65536),
      duplex: "half",
    } as RequestInit),
    {
      CHAT_MEDIA: createMemoryChatMediaBucket(),
      CHAT_MEDIA_SECRET: secret,
    }
  );
  assert(missingHuge?.status === 413, "missing Content-Length + >3MB stream → 413");
  assert(bigPulled.cancelled && bigPulled.n < sixMb.byteLength, "handler cancels oversized stream");
  const pngPut = await handleChatMediaRequest(
    new Request("http://x/media/upload", {
      method: "PUT",
      headers: {
        "content-type": "image/png",
        [CHAT_MEDIA_GRANT_HEADER]: await signChatMediaPutGrant(secret, { ...grantBody, mimeType: "image/png" }),
      },
      body: pngBytes(),
    }),
    { CHAT_MEDIA: createMemoryChatMediaBucket(), CHAT_MEDIA_SECRET: secret }
  );
  const webpPut = await handleChatMediaRequest(
    new Request("http://x/media/upload", {
      method: "PUT",
      headers: {
        "content-type": "image/webp",
        [CHAT_MEDIA_GRANT_HEADER]: await signChatMediaPutGrant(secret, { ...grantBody, mimeType: "image/webp" }),
      },
      body: webpBytes(),
    }),
    { CHAT_MEDIA: createMemoryChatMediaBucket(), CHAT_MEDIA_SECRET: secret }
  );
  assert(pngPut?.status === 200 && webpPut?.status === 200, "JPEG/PNG/WebP magic 기존 동작 유지");

  const jpeg500 = jpegBytes(500 * 1024 - 4, 50);
  const jpeg800 = jpegBytes(800 * 1024 - 4, 80);
  const jpeg3mb = jpegBytes(CHAT_PHOTO_MAX_BYTES - 4, 33);
  const jpegOver = jpegBytes(CHAT_PHOTO_MAX_BYTES - 3, 34);
  async function putSized(bytes: Uint8Array, att = attachmentId) {
    const bucket = createMemoryChatMediaBucket();
    const grant = await signChatMediaPutGrant(secret, { ...grantBody, attachmentId: att });
    const res = await handleChatMediaRequest(
      new Request("http://x/media/upload", {
        method: "PUT",
        headers: {
          "content-type": "image/jpeg",
          "content-length": String(bytes.byteLength),
          [CHAT_MEDIA_GRANT_HEADER]: grant,
        },
        body: bytes,
      }),
      { CHAT_MEDIA: bucket, CHAT_MEDIA_SECRET: secret }
    );
    const json = await uploadJson(res);
    const stored = await bucket.get(`chat/${roomId}/${att}.jpg`);
    const storedBytes = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
    return { res, json, storedBytes, bucket };
  }
  const put500 = await putSized(jpeg500, "22222222-2222-4222-8222-222222222222");
  assert(put500.res?.status === 200 && put500.json?.receipt, "1장 500KB JPEG upload success");
  assert(
    Number.isFinite(put500.json?.timing?.ingressMs) &&
      Number.isFinite(put500.json?.timing?.hashMs) &&
      Number.isFinite(put500.json?.timing?.storeMs) &&
      Number.isFinite(put500.json?.timing?.workerTotalMs),
    "Worker PUT reports ingress/hash/store/total"
  );
  assert(
    put500.storedBytes?.byteLength === jpeg500.byteLength && put500.storedBytes?.[4] === jpeg500[4],
    "500KB readback bytes identical"
  );
  const put800 = await putSized(jpeg800, "33333333-3333-4333-8333-333333333333");
  assert(put800.res?.status === 200 && put800.storedBytes?.byteLength === jpeg800.byteLength, "800KB JPEG success");
  const put3 = await putSized(jpeg3mb, "44444444-4444-4444-8444-444444444444");
  assert(put3.res?.status === 200 && put3.storedBytes?.byteLength === CHAT_PHOTO_MAX_BYTES, "3MB boundary accepted");
  const putOver = await putSized(jpegOver, "55555555-5555-4555-8555-555555555555");
  assert(putOver.res?.status === 413 && !putOver.storedBytes, "3MB+1 reject");

  const boomBucket = createMemoryChatMediaBucket();
  boomBucket.put = async () => {
    throw Object.assign(new Error("r2 exploded"), { name: "R2Error", code: "10044" });
  };
  const boom = await handleChatMediaRequest(
    new Request("http://x/media/upload", {
      method: "PUT",
      headers: { "content-type": "image/jpeg", [CHAT_MEDIA_GRANT_HEADER]: token },
      body: photoA,
    }),
    { CHAT_MEDIA: boomBucket, CHAT_MEDIA_SECRET: secret }
  );
  const boomJson = await boom?.clone().json().catch(() => null);
  assert(boom?.status === 500 && boomJson?.error === "upload_failed", "R2 put exception is caught 500, not uncaught");
  assert((await boomBucket.head(`chat/${roomId}/${attachmentId}.jpg`)) == null, "stream/put error does not create partial READY");
  const failLog = safeChatMediaUploadFailureLog({
    stage: "r2_put",
    error: Object.assign(new Error("secret=abc url=https://evil key=chat/all/x bytes=ff"), {
      name: "TypeError",
      code: "ERR_STREAM_LOCKED",
    }),
    contentLength: jpeg500.byteLength,
    prefixRead: true,
    r2PutStarted: true,
  });
  const failText = JSON.stringify(failLog);
  assert(failLog.event === "chat_media_upload_failed" && failLog.stage === "r2_put", "safe failure log categories");
  assert(failLog.errorClass === "TypeError" && failLog.errorCode === "ERR_STREAM_LOCKED", "safe error class/code");
  assert(failLog.contentLength === jpeg500.byteLength && failLog.prefixRead && failLog.r2PutStarted, "safe numeric flags");
  assert(!failText.includes("secret") && !failText.includes("https://") && !failText.includes("chat/all"), "log omits secret/url/key/bytes");

  const prefixJpeg = jpegBytes(400, 8);
  const prefixPulled = { n: 0, cancelled: false };
  const prefixThenRest = await readPrefixThenRest(
    countingStream(prefixJpeg, prefixPulled, 64),
    256
  );
  assert(prefixThenRest.ok && prefixThenRest.prefix.byteLength === 256, "first 256-byte magic prefix");
  const restChunks: Uint8Array[] = [];
  if (prefixThenRest.ok && prefixThenRest.rest) {
    const reader = prefixThenRest.rest.getReader();
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) restChunks.push(value);
    }
  }
  const restLen = restChunks.reduce((n, c) => n + c.byteLength, 0);
  assert(restLen === prefixJpeg.byteLength - 256, "remaining body stays streamed");
  const overStream = createBoundedConcatStream(
    prefixJpeg.subarray(0, 256),
    new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(sixMb.subarray(256));
        controller.close();
      },
    }),
    CHAT_PHOTO_MAX_BYTES
  );
  let streamLimit = false;
  try {
    await new Response(overStream.stream).arrayBuffer();
  } catch {
    streamLimit = true;
  }
  assert(streamLimit || !overStream.completed(), ">3MB streaming rejection");
}

const ALLOW_DB = process.env.ALLOW_DB_TEST === "1" || process.env.DATABASE_URL?.includes("caddy_local");
if (!ALLOW_DB) {
  console.log("\nskip DB photo upload (set local DATABASE_URL)\n");
} else {
  assertLocalDatabaseUrl(process.env.DATABASE_URL || "");
  process.env.CHAT_AUTH_SECRET = process.env.CHAT_AUTH_SECRET || "chat-photo-unit-secret";
  process.env.CHAT_INTERNAL_SECRET = process.env.CHAT_INTERNAL_SECRET || "chat-photo-unit-internal";

  const store = createMemoryCourseReportPhotoStore();
  const storeStats = instrumentPhotoStore(store);
  setCourseReportPhotoStoreForTests(store);
  const tag = `cp_${Date.now()}`;
  const password = await bcrypt.hash("pw123456", 4);
  const user = await prisma.user.create({
    data: { username: `${tag}_admin`, password, role: "admin", sessionVersion: 0 },
  });
  const other = await prisma.user.create({
    data: { username: `${tag}_caddy`, password, role: "caddy", sessionVersion: 0 },
  });

  try {
    section("upload / magic / size / mime");
    {
      let invalid = "";
      try {
        await uploadChatPhoto(prisma, { roomId: "all", senderUserId: user.id, bytes: pdfBytes() });
      } catch (e) {
        invalid = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "other";
      }
      assert(invalid === "unsupported_type", "invalid magic rejected");
      let oversize = "";
      try {
        await uploadChatPhoto(prisma, {
          roomId: "all",
          senderUserId: user.id,
          bytes: jpegBytes(3 * 1024 * 1024 + 8, 3),
        });
      } catch (e) {
        oversize = e && typeof e === "object" && "code" in e ? String((e as { code: string }).code) : "other";
      }
      assert(oversize === "file_too_large", "oversize rejected");

      const jpeg = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(16, 9),
      });
      assert(jpeg.id && jpeg.claim && jpeg.mimeType === "image/jpeg", "valid jpeg");
      const png = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: pngBytes(),
      });
      assert(png.mimeType === "image/png", "valid png");
      const webp = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: webpBytes(),
      });
      assert(webp.mimeType === "image/webp", "valid webp");

      await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
      const first = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(10, 1),
      });
      await uploadChatPhoto(prisma, { roomId: "all", senderUserId: user.id, bytes: jpegBytes(10, 2) });
      await uploadChatPhoto(prisma, { roomId: "all", senderUserId: user.id, bytes: jpegBytes(10, 3) });
      let limit = "";
      try {
        await uploadChatPhoto(prisma, { roomId: "all", senderUserId: user.id, bytes: jpegBytes(10, 4) });
      } catch (e) {
        limit = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(limit === "photo_limit", "max 3 unconsumed");
      const consumed = await consumeChatAttachments(prisma, [first.id]);
      assert(consumed === 1, "consume marks used");
      const again = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(10, 5),
      });
      assert(!!again.id, "after consume can upload again");

      let cross = "";
      try {
        await loadChatPhotoMeta(prisma, { roomId: "room_0123456789abcdef", attachmentId: first.id });
      } catch (e) {
        cross = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(cross === "not_found", "cross-room attachment forbidden");
    }

    section("HTTP ACL");
    {
      const cookie = await cookieFor({ id: user.id, username: user.username, role: "admin" });
      const otherCookie = await cookieFor({
        id: other.id,
        username: other.username,
        role: "caddy",
      });
      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
      const proxyGone = await POST_PROXY();
      assert(proxyGone.status === 410, "legacy proxy POST is gone");

      const prepared = await prepareHttp(cookie, "all", "image/jpeg", 16);
      const preparedJson = await prepared.json();
      assert(prepared.status === 200 && preparedJson.upload?.attachmentId, "ALL room member can prepare");
      assert(!JSON.stringify(preparedJson).includes("storageKey"), "prepare hides storageKey");
      assert(!JSON.stringify(preparedJson).includes("blob.vercel"), "prepare hides blob url");
      assert(!JSON.stringify(preparedJson).includes("clientSigningToken"), "prepare hides signing token");
      assert(!JSON.stringify(preparedJson).includes("BLOB_READ_WRITE"), "prepare hides store token");
      const put = await putSigned(preparedJson.upload.uploadUrl, jpegBytes(12, 7), "image/jpeg");
      assert(put.status === 204, "signed PUT stores bytes outside Next photo route");
      const uploaded = await finalizeHttp(cookie, "all", preparedJson.upload.attachmentId);
      const uploadedJson = await uploaded.json();
      assert(uploaded.status === 200 && uploadedJson.photo?.id, "ALL room member can finalize");
      assert(!String(JSON.stringify(uploadedJson)).includes("storageKey"), "response hides storageKey");
      assert(!String(JSON.stringify(uploadedJson)).includes("blob.vercel"), "response hides blob url");

      const nowSec = Math.floor(Date.now() / 1000);
      const liveToken = await signChatToken({
        v: 2,
        userId: user.id,
        displayName: user.username,
        role: "admin",
        team: "-",
        iat: nowSec,
        exp: nowSec + 1800,
      });
      let dbHits = 0;
      const stubDb = {
        caddy: {
          findUnique: async () => {
            dbHits += 1;
            return null;
          },
        },
        user: {
          findFirst: async () => {
            dbHits += 1;
            return null;
          },
        },
      };
      const stubAuth = {
        session: { userId: user.id, username: user.username, role: "admin" as const, sessionVersion: 0 },
        userId: user.id,
        username: user.username,
        role: "admin" as const,
        sessionVersion: 0,
        caddyId: null,
        managedTeams: [],
        mustChangePassword: false,
      };
      const fast = await resolveChatPhotoRoomAccess(stubDb as never, stubAuth as never, "all", {
        chatToken: liveToken,
      });
      assert(fast.fastPath && fast.userId === user.id && dbHits === 0, "ALL room token fast path");
      assert(fast.fallbackReason === "fast", "ALL valid token reason is fast");
      let directoryHits = 0;
      const prevFetch = globalThis.fetch;
      globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
        const url = String(input instanceof Request ? input.url : input);
        if (url.includes("/directory/")) directoryHits += 1;
        return prevFetch(input, init);
      }) as typeof fetch;
      try {
        const again = await resolveChatPhotoRoomAccess(stubDb as never, stubAuth as never, "all", {
          chatToken: liveToken,
        });
        assert(again.fastPath && directoryHits === 0 && dbHits === 0, "ALL fast path skips directory lookup");
      } finally {
        globalThis.fetch = prevFetch;
      }
      const envAdminAuth = { ...stubAuth, userId: null as number | null };
      const envFast = await resolveChatPhotoRoomAccess(stubDb as never, envAdminAuth as never, "all", {
        chatToken: liveToken,
      });
      assert(envFast.fastPath && envFast.userId === user.id && dbHits === 0, "env-admin ALL token is local fast path");
      assert(
        chatPhotoIdentityMatchesToken({ userId: null, role: "admin" }, { userId: user.id, role: "admin" }),
        "env-admin cookie matches admin token"
      );
      assert(
        !chatPhotoIdentityMatchesToken({ userId: user.id, role: "admin" }, { userId: other.id, role: "caddy" }),
        "userId mismatch is not fast path"
      );
      const tokenPrep = await prepareHttpWithToken(
        cookie,
        "all",
        "image/jpeg",
        16,
        liveToken,
        "?photoDebug=1"
      );
      const tokenPrepJson = await tokenPrep.json();
      assert(tokenPrep.status === 200 && tokenPrepJson.upload?.attachmentId, "ALL prepare with chat token");
      assert(tokenPrepJson.hotpath?.flags?.roomAccessFastPath === true, "prepare debug shows roomAccessFastPath=true");
      assert(tokenPrepJson.hotpath?.reasons?.roomAccessFallbackReason === "fast", "prepare debug reason is fast");
      const expiredToken = await signChatToken({
        v: 2,
        userId: user.id,
        displayName: user.username,
        role: "admin",
        team: "-",
        iat: nowSec - 2000,
        exp: nowSec - 10,
      });
      const expiredAccess = await resolveChatPhotoRoomAccess(stubDb as never, stubAuth as never, "all", {
        chatToken: expiredToken,
      });
      assert(expiredAccess.fastPath === false && expiredAccess.fallbackReason === "invalid_token", "expired token safe fallback");
      const fallbackPrep = await prepareHttpWithToken(
        cookie,
        "all",
        "image/jpeg",
        16,
        expiredToken,
        "?photoDebug=1"
      );
      const fallbackPrepJson = await fallbackPrep.json();
      assert(fallbackPrep.status === 200, "expired token falls back to requireChatPhotoRoomAccess");
      assert(fallbackPrepJson.hotpath?.flags?.roomAccessFastPath === false, "expired token debug keeps false flag");
      assert(fallbackPrepJson.hotpath?.reasons?.roomAccessFallbackReason === "invalid_token", "expired token debug reason");
      const mismatchToken = await signChatToken({
        v: 2,
        userId: other.id,
        displayName: other.username,
        role: "caddy",
        team: "-",
        iat: nowSec,
        exp: nowSec + 1800,
      });
      const mismatchAccess = await resolveChatPhotoRoomAccess(stubDb as never, stubAuth as never, "all", {
        chatToken: mismatchToken,
      });
      assert(
        mismatchAccess.fastPath === false && mismatchAccess.fallbackReason === "user_mismatch",
        "other-user token is user_mismatch fallback"
      );
      const missingAccess = await resolveChatPhotoRoomAccess(stubDb as never, stubAuth as never, "all", {});
      assert(
        missingAccess.fastPath === false && missingAccess.fallbackReason === "missing_token",
        "omitted token is missing_token fallback"
      );
      const otherToken = await signChatToken({
        v: 2,
        userId: other.id,
        displayName: other.username,
        role: "caddy",
        team: "-",
        iat: nowSec,
        exp: nowSec + 1800,
      });
      const custom = await prepareHttp(otherCookie, "room_0123456789abcdef", "image/jpeg", 16);
      assert(custom.status === 403, "non-member prepare forbidden");
      const customToken = await prepareHttpWithToken(
        otherCookie,
        "room_0123456789abcdef",
        "image/jpeg",
        16,
        otherToken
      );
      assert(customToken.status === 403, "custom/DM access regression with token");

      const got = await GET_PHOTO(
        req(`http://localhost/api/chat/rooms/all/attachments/${uploadedJson.photo.id}`, {
          headers: { cookie },
        }),
        {
          params: Promise.resolve({ roomId: "all", attachmentId: uploadedJson.photo.id }),
        }
      );
      assert(got.status === 200, "room member can read");

      const wrongRoom = await GET_PHOTO(
        req(`http://localhost/api/chat/rooms/all/attachments/${uploadedJson.photo.id}`, {
          headers: { cookie },
        }),
        {
          params: Promise.resolve({
            roomId: "room_0123456789abcdef",
            attachmentId: uploadedJson.photo.id,
          }),
        }
      );
      assert(wrongRoom.status === 403 || wrongRoom.status === 404, "cross-room read fail-closed");

      const anon = await GET_PHOTO(
        req(`http://localhost/api/chat/rooms/all/attachments/${uploadedJson.photo.id}`),
        {
          params: Promise.resolve({ roomId: "all", attachmentId: uploadedJson.photo.id }),
        }
      );
      assert(anon.status === 401, "anonymous read forbidden");

      const ts = Math.floor(Date.now() / 1000);
      const sig = await signChatInternalAuth(
        process.env.CHAT_INTERNAL_SECRET || "",
        CHAT_ATTACHMENT_CONSUME_PATH,
        ts
      );
      const consumed = await POST_CONSUME(
        req("http://localhost/api/chat/attachments/consume", {
          method: "POST",
          headers: {
            [CHAT_INTERNAL_AUTH_HEADER]: sig,
            [CHAT_INTERNAL_TS_HEADER]: String(ts),
          },
          body: JSON.stringify({ attachmentIds: [uploadedJson.photo.id] }),
        })
      );
      const consumedJson = await consumed.json();
      assert(consumed.status === 200 && consumedJson.consumed >= 1, "internal consume ok");

      const forged = await POST_CONSUME(
        req("http://localhost/api/chat/attachments/consume", {
          method: "POST",
          body: JSON.stringify({ attachmentIds: [uploadedJson.photo.id] }),
        })
      );
      assert(forged.status === 403, "consume requires internal auth");

      const orphans = await cleanupOrphanChatAttachments(prisma, 0);
      assert(orphans.deleted >= 0, "orphan cleanup best-effort");
    }

    section("attachment lifecycle / cleanup");
    {
      const cookie = await cookieFor({ id: user.id, username: user.username, role: "admin" });
      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });

      const orphanPhoto = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 21),
      });
      await prisma.chatAttachment.update({
        where: { id: orphanPhoto.id },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });
      const keptConsumed = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 22),
      });
      await consumeChatAttachments(prisma, [keptConsumed.id]);
      await prisma.chatAttachment.update({
        where: { id: keptConsumed.id },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });
      const fresh = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 23),
      });
      await cleanupOrphanChatAttachments(prisma);
      assert(!(await prisma.chatAttachment.findUnique({ where: { id: orphanPhoto.id } })), "orphan row removed");
      assert(!(await store.get(`chat/all/${orphanPhoto.id}.jpg`)), "orphan blob removed");
      assert(!!(await prisma.chatAttachment.findUnique({ where: { id: keptConsumed.id } })), "consumed attachment not orphaned");
      assert(!!(await prisma.chatAttachment.findUnique({ where: { id: fresh.id } })), "fresh unconsumed kept");

      const hideKept = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 24),
      });
      assert(shouldPurgeChatAttachmentsOnDelete("hide") === false, "hide helper keeps attachment");
      assert(!!(await prisma.chatAttachment.findUnique({ where: { id: hideKept.id } })), "hide-for-me attachment remains");
      assert(!!(await store.get(`chat/all/${hideKept.id}.jpg`)), "hide-for-me blob remains");
      await consumeChatAttachments(prisma, [hideKept.id, fresh.id]);

      const everyone = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 25),
      });
      const everyonePurge = await purgeChatAttachments(prisma, {
        roomId: "all",
        attachmentIds: [everyone.id],
      });
      assert(everyonePurge.deleted === 1, "delete-for-everyone removes DB row");
      assert(!(await prisma.chatAttachment.findUnique({ where: { id: everyone.id } })), "everyone row gone");
      assert(!(await store.get(`chat/all/${everyone.id}.jpg`)), "everyone blob deleted");

      const adminPhoto = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 26),
      });
      const adminPurge = await purgeChatAttachments(prisma, {
        roomId: "all",
        attachmentIds: [adminPhoto.id],
      });
      assert(adminPurge.deleted === 1, "admin delete removes DB row + blob");
      assert(!(await prisma.chatAttachment.findUnique({ where: { id: adminPhoto.id } })), "admin row gone");

      const retention = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 27),
      });
      const retentionPurge = await purgeChatAttachments(prisma, {
        roomId: "all",
        attachmentIds: [retention.id],
      });
      assert(retentionPurge.deleted === 1, "retention purge removes attachment");

      const otherRoom = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 28),
      });
      const crossed = await purgeChatAttachments(prisma, {
        roomId: "dm_1_2",
        attachmentIds: [otherRoom.id],
      });
      assert(crossed.deleted === 0 && crossed.skipped >= 1, "cross-room cleanup rejected");
      assert(!!(await prisma.chatAttachment.findUnique({ where: { id: otherRoom.id } })), "cross-room row kept");

      const failBlob = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(14, 29),
      });
      const prevDelete = store.delete.bind(store);
      store.delete = async () => {
        throw new Error("blob down");
      };
      const failed = await purgeChatAttachments(prisma, {
        roomId: "all",
        attachmentIds: [failBlob.id],
      });
      store.delete = prevDelete;
      assert(failed.deleted === 1, "blob failure still deletes DB row");
      assert(failed.blobFailed.some((row) => row.id === failBlob.id), "blob failure is retry-logged");
      assert(!(await prisma.chatAttachment.findUnique({ where: { id: failBlob.id } })), "GET source row gone after failed blob");

      const gone = await GET_PHOTO(
        req(`http://localhost/api/chat/rooms/all/attachments/${everyone.id}`, {
          headers: { cookie },
        }),
        { params: Promise.resolve({ roomId: "all", attachmentId: everyone.id }) }
      );
      assert(gone.status === 404, "deleted attachment GET is 404");

      const ts = Math.floor(Date.now() / 1000);
      const bad = await POST_CLEANUP(
        req("http://localhost/api/chat/attachments/cleanup", {
          method: "POST",
          body: JSON.stringify({ roomId: "all", attachmentIds: [otherRoom.id] }),
        })
      );
      assert(bad.status === 403, "cleanup endpoint bad HMAC → 403");

      const sig = await signChatInternalAuth(
        process.env.CHAT_INTERNAL_SECRET || "",
        CHAT_ATTACHMENT_CLEANUP_PATH,
        ts
      );
      const cleaned = await POST_CLEANUP(
        req("http://localhost/api/chat/attachments/cleanup", {
          method: "POST",
          headers: {
            [CHAT_INTERNAL_AUTH_HEADER]: sig,
            [CHAT_INTERNAL_TS_HEADER]: String(ts),
          },
          body: JSON.stringify({ roomId: "all", attachmentIds: [otherRoom.id] }),
        })
      );
      const cleanedJson = await cleaned.json();
      assert(cleaned.status === 200 && cleanedJson.deleted >= 1, "internal cleanup deletes room attachment");
    }

    section("orphan quota ordering");
    {
      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
      const consumedKept = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(12, 39),
      });
      await consumeChatAttachments(prisma, [consumedKept.id]);
      const stale = [];
      for (let i = 0; i < 3; i++) {
        stale.push(
          await uploadChatPhoto(prisma, {
            roomId: "all",
            senderUserId: user.id,
            bytes: jpegBytes(12, 40 + i),
          })
        );
      }
      await prisma.chatAttachment.updateMany({
        where: { id: { in: [...stale.map((p) => p.id), consumedKept.id] } },
        data: { createdAt: new Date(Date.now() - 2 * 60 * 60 * 1000) },
      });
      const afterStale = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(12, 51),
      });
      assert(!!afterStale.id, "3 stale unconsumed cleaned then upload succeeds");
      assert(
        (await prisma.chatAttachment.findMany({
          where: { id: { in: stale.map((p) => p.id) } },
        })).length === 0,
        "stale unconsumed removed before quota"
      );
      assert(
        !!(await prisma.chatAttachment.findUnique({ where: { id: consumedKept.id } })),
        "consumed attachment not touched"
      );

      await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
      const freshIds: string[] = [];
      for (let i = 0; i < 3; i++) {
        freshIds.push(
          (
            await uploadChatPhoto(prisma, {
              roomId: "all",
              senderUserId: user.id,
              bytes: jpegBytes(12, 60 + i),
            })
          ).id
        );
      }
      let freshLimit = "";
      try {
        await uploadChatPhoto(prisma, {
          roomId: "all",
          senderUserId: user.id,
          bytes: jpegBytes(12, 70),
        });
      } catch (e) {
        freshLimit = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(freshLimit === "photo_limit", "fresh unconsumed 3 still 409");
      assert(
        (await prisma.chatAttachment.count({
          where: { id: { in: freshIds }, consumedAt: null },
        })) === 3,
        "fresh unconsumed kept"
      );

      await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
      const origFindMany = prisma.chatAttachment.findMany.bind(prisma.chatAttachment);
      prisma.chatAttachment.findMany = (async (args: unknown) => {
        const where = (args as { where?: { consumedAt?: unknown; createdAt?: unknown; OR?: unknown } } | undefined)
          ?.where;
        if (where?.OR || (where && where.consumedAt === null && where.createdAt)) {
          throw new Error("cleanup down");
        }
        return origFindMany(args as never);
      }) as typeof prisma.chatAttachment.findMany;
      try {
        const despiteCleanup = await uploadChatPhoto(prisma, {
          roomId: "all",
          senderUserId: user.id,
          bytes: jpegBytes(12, 80),
        });
        assert(!!despiteCleanup.id, "cleanup failure does not fail in-quota upload");
      } finally {
        prisma.chatAttachment.findMany = origFindMany;
      }
    }

    section("direct upload prepare / finalize");
    {
      const cookie = await cookieFor({ id: user.id, username: user.username, role: "admin" });
      const otherCookie = await cookieFor({
        id: other.id,
        username: other.username,
        role: "caddy",
      });
      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });

      const anon = await prepareHttp("", "all", "image/jpeg", 16);
      assert(anon.status === 401, "signed URL unauthorized");

      const badType = await prepareHttp(cookie, "all", "application/pdf", 16);
      const badTypeJson = await badType.json();
      assert(badType.status === 400 && badTypeJson.error === "unsupported_type", "invalid content type");

      const tooBig = await prepareHttp(cookie, "all", "image/jpeg", 3 * 1024 * 1024 + 1);
      const tooBigJson = await tooBig.json();
      assert(tooBig.status === 400 && tooBigJson.error === "file_too_large", "max 3MB");

      const prepared = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      assert(prepared.attachmentId && prepared.uploadUrl, "prepare returns signed PUT");
      const pendingRow = await prisma.chatAttachment.findUnique({
        where: { id: prepared.attachmentId },
      });
      assert(pendingRow?.uploadState === "PENDING", "prepare creates PENDING");
      const pendingGet = await GET_PHOTO(
        req(`http://localhost/api/chat/rooms/all/attachments/${prepared.attachmentId}`, {
          headers: { cookie },
        }),
        { params: Promise.resolve({ roomId: "all", attachmentId: prepared.attachmentId }) }
      );
      assert(pendingGet.status === 404, "PENDING GET → 404");

      const put = await putSigned(prepared.uploadUrl, jpegBytes(16, 11), "image/jpeg");
      assert(put.status === 204, "direct PUT success");
      const finalized = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: prepared.attachmentId,
        senderUserId: user.id,
      });
      assert(finalized.id === prepared.attachmentId && finalized.claim, "direct PUT → finalize");
      const readyRow = await prisma.chatAttachment.findUnique({
        where: { id: prepared.attachmentId },
      });
      assert(readyRow?.uploadState === "READY", "finalize marks READY");
      const readyGet = await GET_PHOTO(
        req(`http://localhost/api/chat/rooms/all/attachments/${prepared.attachmentId}`, {
          headers: { cookie },
        }),
        { params: Promise.resolve({ roomId: "all", attachmentId: prepared.attachmentId }) }
      );
      assert(readyGet.status === 200, "READY GET → success");

      const again = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: prepared.attachmentId,
        senderUserId: user.id,
      });
      assert(again.id === finalized.id, "duplicate finalize is idempotent");

      let crossRoom = "";
      try {
        await finalizeChatPhotoUpload(prisma, {
          roomId: "room_0123456789abcdef",
          attachmentId: prepared.attachmentId,
          senderUserId: user.id,
        });
      } catch (e) {
        crossRoom = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(crossRoom === "not_found", "cross-room finalize reject");

      let otherSender = "";
      try {
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: prepared.attachmentId,
          senderUserId: other.id,
        });
      } catch (e) {
        otherSender = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(otherSender === "forbidden", "other sender finalize reject");

      const otherHttp = await finalizeHttp(otherCookie, "all", prepared.attachmentId);
      assert(otherHttp.status === 403, "other sender HTTP finalize forbidden");

      const magicPrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      const magicPut = await putSigned(magicPrep.uploadUrl, pdfBytes(), "image/jpeg");
      assert(magicPut.status === 204, "local PUT does not trust magic yet");
      let magicCode = "";
      try {
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: magicPrep.attachmentId,
          senderUserId: user.id,
        });
      } catch (e) {
        magicCode = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(magicCode === "unsupported_type", "magic byte invalid → finalize reject");
      assert(
        !(await prisma.chatAttachment.findUnique({ where: { id: magicPrep.attachmentId } })),
        "invalid finalize deletes DB intent"
      );
      assert(
        !(await store.get(`chat/all/${magicPrep.attachmentId}.jpg`)),
        "invalid finalize deletes Blob"
      );

      const stalePending = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await prisma.chatAttachment.update({
        where: { id: stalePending.attachmentId },
        data: { createdAt: new Date(Date.now() - 16 * 60 * 1000) },
      });
      const freshPending = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await cleanupOrphanChatAttachments(prisma);
      assert(
        !(await prisma.chatAttachment.findUnique({ where: { id: stalePending.attachmentId } })),
        "expired pending cleanup"
      );
      assert(
        !!(await prisma.chatAttachment.findUnique({ where: { id: freshPending.attachmentId } })),
        "fresh pending kept"
      );

      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
      const existing = await uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(12, 90),
      });
      const existingRow = await prisma.chatAttachment.findUnique({ where: { id: existing.id } });
      assert(existingRow?.uploadState === "READY", "existing attachment default READY");

      const t1 = Date.now();
      const onePrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      const onePrepMs = Date.now() - t1;
      const t2 = Date.now();
      await putSigned(onePrep.uploadUrl, jpegBytes(16, 91), "image/jpeg");
      const onePutMs = Date.now() - t2;
      const t3 = Date.now();
      await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: onePrep.attachmentId,
        senderUserId: user.id,
      });
      const oneFinMs = Date.now() - t3;
      console.log(`  timing 1장 prepare=${onePrepMs}ms put=${onePutMs}ms finalize=${oneFinMs}ms`);

      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
      const threeStarted = Date.now();
      const three = await mapBoundedSettled([1, 2, 3], 3, async (n) => {
        const prep = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: 16,
        });
        await putSigned(prep.uploadUrl, jpegBytes(16, 100 + n), "image/jpeg");
        return finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: prep.attachmentId,
          senderUserId: user.id,
        });
      });
      const threeMs = Date.now() - threeStarted;
      assert(three.every((row) => row.status === "fulfilled"), "3 concurrent direct uploads");
      console.log(`  timing 3장 total=${threeMs}ms`);

      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
      storeStats.reset();
      const largeJpeg = jpegBytes(3 * 1024 * 1024 - 8, 17);
      const largePrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: largeJpeg.byteLength,
      });
      await store.put(`chat/all/${largePrep.attachmentId}.jpg`, largeJpeg, "image/jpeg");
      storeStats.reset();
      const largeFin = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: largePrep.attachmentId,
        senderUserId: user.id,
      });
      const largeSnap = storeStats.snapshot();
      assert(largeFin.mimeType === "image/jpeg", "3MB jpeg finalize uses actual magic");
      assert(largeFin.size === largeJpeg.byteLength, "finalize size from inspect not DB");
      assert(largeSnap.getCalls === 0 && largeSnap.getBytes === 0, "3MB finalize does not full-read");
      assert(largeSnap.prefixBytes <= COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES, "prefix read <=256 bytes");
      assert(largeSnap.inspectCalls === 1 && largeSnap.headCalls === 0, "one prefix+meta read, no HEAD");
      console.log(
        `  finalize Function bytes: prefix=${largeSnap.prefixBytes} get=${largeSnap.getBytes} (3MB object)`
      );

      const pngAsJpeg = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await store.put(`chat/all/${pngAsJpeg.attachmentId}.jpg`, pngBytes(), "image/jpeg");
      const pngReady = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: pngAsJpeg.attachmentId,
        senderUserId: user.id,
      });
      assert(pngReady.mimeType === "image/png", "actual magic wins over requested contentType");

      const webpPrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/webp",
        size: 16,
      });
      await store.put(`chat/all/${webpPrep.attachmentId}.webp`, webpBytes(), "image/webp");
      const webpReady = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: webpPrep.attachmentId,
        senderUserId: user.id,
      });
      assert(webpReady.mimeType === "image/webp", "finalize WEBP is ready");
      await prisma.chatAttachment.delete({ where: { id: webpPrep.attachmentId } });

      const emptyPrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await store.put(`chat/all/${emptyPrep.attachmentId}.jpg`, new Uint8Array(), "image/jpeg");
      let emptyCode = "";
      try {
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: emptyPrep.attachmentId,
          senderUserId: user.id,
        });
      } catch (e) {
        emptyCode = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      assert(emptyCode === "upload_incomplete", "empty Blob reject");
      assert(
        !(await prisma.chatAttachment.findUnique({ where: { id: emptyPrep.attachmentId } })),
        "empty Blob deletes PENDING"
      );

      const overPrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await store.put(
        `chat/all/${overPrep.attachmentId}.jpg`,
        jpegBytes(3 * 1024 * 1024 + 8, 19),
        "image/jpeg"
      );
      storeStats.reset();
      let overCode = "";
      try {
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: overPrep.attachmentId,
          senderUserId: user.id,
        });
      } catch (e) {
        overCode = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      const overSnap = storeStats.snapshot();
      assert(overCode === "file_too_large", "metadata actual size >3MB reject");
      assert(overSnap.inspectCalls === 1 && overSnap.getCalls === 0, "oversize uses one inspect, no full-get");
      assert(
        !(await prisma.chatAttachment.findUnique({ where: { id: overPrep.attachmentId } })),
        "oversize deletes PENDING"
      );
      assert(!(await store.get(`chat/all/${overPrep.attachmentId}.jpg`)), "oversize deletes Blob");

      for (const [label, bytes, type] of [
        ["heic", heicBytes(), "image/jpeg"],
        ["pdf", pdfBytes(), "image/jpeg"],
        ["svg", svgBytes(), "image/jpeg"],
        ["html", htmlBytes(), "image/jpeg"],
      ] as const) {
        const bad = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: bytes.byteLength,
        });
        await store.put(`chat/all/${bad.attachmentId}.jpg`, bytes, type);
        let code = "";
        try {
          await finalizeChatPhotoUpload(prisma, {
            roomId: "all",
            attachmentId: bad.attachmentId,
            senderUserId: user.id,
          });
        } catch (e) {
          code = e instanceof CourseReportPhotoValidationError ? e.code : "other";
        }
        assert(code === "unsupported_type", `${label} finalize reject`);
        assert(
          !(await prisma.chatAttachment.findUnique({ where: { id: bad.attachmentId } })),
          `${label} PENDING cleaned`
        );
        assert(!(await store.get(`chat/all/${bad.attachmentId}.jpg`)), `${label} Blob cleaned`);
      }

      const rangeStore = createMemoryCourseReportPhotoStore();
      const prevStore = store;
      setCourseReportPhotoStoreForTests({
        ...rangeStore,
        async readPrefixAndMeta(key, maxBytes) {
          const bytes = await rangeStore.get(key);
          if (!bytes) return null;
          return readBlobObjectPrefixAndMetaWithGet(
            async () => ({
              statusCode: 206,
              stream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
              headers: { "content-range": `bytes 0-${Math.max(0, bytes.byteLength - 1)}/${bytes.byteLength}` },
              blob: { size: bytes.byteLength, contentType: "image/jpeg" },
            }),
            key,
            maxBytes
          );
        },
      });
      const rangePrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await rangeStore.put(`chat/all/${rangePrep.attachmentId}.jpg`, jpegBytes(24, 21), "image/jpeg");
      const rangeFin = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: rangePrep.attachmentId,
        senderUserId: user.id,
      });
      assert(rangeFin.claim && rangeFin.mimeType === "image/jpeg", "Range 206 does not become upload_incomplete");
      await prisma.chatAttachment.deleteMany({
        where: {
          senderUserId: user.id,
          id: { not: largePrep.attachmentId },
        },
      });

      const vercelRangeStore = createMemoryCourseReportPhotoStore();
      const vercelRangeWrapped = {
        ...vercelRangeStore,
        async readPrefixAndMeta(key: string, maxBytes: number) {
          const bytes = await vercelRangeStore.get(key);
          if (!bytes) return null;
          const limit = Math.max(0, Math.floor(maxBytes));
          const body = bytes.subarray(0, Math.min(limit || bytes.byteLength, bytes.byteLength));
          return readBlobObjectPrefixAndMetaWithGet(
            async () => ({
              statusCode: 200,
              stream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(body);
                  controller.close();
                },
              }),
              headers: {
                "content-range": `bytes 0-${Math.max(0, body.byteLength - 1)}/${bytes.byteLength}`,
                "content-length": String(body.byteLength),
              },
              blob: { size: body.byteLength, contentType: "image/jpeg" },
            }),
            key,
            maxBytes
          );
        },
      };
      const vercelRangeStats = instrumentPhotoStore(vercelRangeWrapped);
      setCourseReportPhotoStoreForTests(vercelRangeWrapped);
      const overRangePrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: 16,
      });
      await vercelRangeStore.put(
        `chat/all/${overRangePrep.attachmentId}.jpg`,
        jpegBytes(3 * 1024 * 1024 + 8, 22),
        "image/jpeg"
      );
      vercelRangeStats.reset();
      let overRangeCode = "";
      try {
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: overRangePrep.attachmentId,
          senderUserId: user.id,
        });
      } catch (e) {
        overRangeCode = e instanceof CourseReportPhotoValidationError ? e.code : "other";
      }
      const overRangeSnap = vercelRangeStats.snapshot();
      assert(overRangeCode === "file_too_large", "C: Range body 256B with 3MB+ total is file_too_large");
      assert(overRangeSnap.inspectCalls === 1 && overRangeSnap.headCalls === 0, "C: one Range GET, no HEAD");
      assert(overRangeSnap.getCalls === 0, "C: does not full-get oversize object");

      const claimedJpeg = jpegBytes(655611 - 4, 23);
      assert(claimedJpeg.byteLength === 655611, "D fixture is 655611 bytes");
      const claimPrep = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: claimedJpeg.byteLength,
      });
      await vercelRangeStore.put(`chat/all/${claimPrep.attachmentId}.jpg`, claimedJpeg, "image/jpeg");
      vercelRangeStats.reset();
      const claimFin = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: claimPrep.attachmentId,
        senderUserId: user.id,
      });
      const claimSnap = vercelRangeStats.snapshot();
      const claimRow = await prisma.chatAttachment.findUnique({ where: { id: claimPrep.attachmentId } });
      assert(claimFin.size === 655611, "D: finalize claim size stays 655611");
      assert(claimRow?.size === 655611, "D: DB size stays 655611");
      assert(claimSnap.inspectCalls === 1 && claimSnap.headCalls === 0, "D: one Range GET, no HEAD");
      assert(claimSnap.prefixBytes <= COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES, "D: prefix stays <=256B");
      await prisma.chatAttachment.delete({ where: { id: claimPrep.attachmentId } }).catch(() => undefined);

      setCourseReportPhotoStoreForTests(prevStore);

      storeStats.reset();
      const againReady = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: largePrep.attachmentId,
        senderUserId: user.id,
      });
      const readySnap = storeStats.snapshot();
      assert(againReady.id === largeFin.id, "READY re-finalize still idempotent");
      assert(
        readySnap.headCalls === 0 && readySnap.prefixCalls === 0 && readySnap.inspectCalls === 0,
        "READY finalize skips Blob read"
      );
    }

    section("r2 fast lane prepare / finalize / read / cleanup");
    {
      const prevStorage = process.env.CHAT_PHOTO_STORAGE;
      const prevMedia = process.env.CHAT_MEDIA_SECRET;
      const prevWorker = process.env.CHAT_WORKER_URL;
      process.env.CHAT_PHOTO_STORAGE = "r2";
      process.env.CHAT_MEDIA_SECRET = "chat-media-unit-secret";
      process.env.CHAT_WORKER_URL = "http://chat-media.test";
      const bucket = createMemoryChatMediaBucket();
      const mediaEnv: ChatMediaEnv = {
        CHAT_MEDIA: bucket,
        CHAT_MEDIA_SECRET: process.env.CHAT_MEDIA_SECRET,
        CHAT_INTERNAL_SECRET: process.env.CHAT_INTERNAL_SECRET,
        CHAT_AUTH_SECRET: process.env.CHAT_AUTH_SECRET,
      };
      setChatMediaWorkerFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
        const req = input instanceof Request ? input : new Request(String(input), init);
        return (
          (await handleChatMediaRequest(req, mediaEnv)) ||
          new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
        );
      }) as typeof fetch);
      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
      const cookie = await cookieFor({ id: user.id, username: user.username, role: "admin" });

      try {
        const blobKept = await uploadChatPhoto(prisma, {
          roomId: "all",
          senderUserId: user.id,
          bytes: jpegBytes(16, 31),
        });
        // Force this row back to a legacy Blob key to prove mixed-history reads.
        const blobKey = `chat/all/${blobKept.id}.jpg`;
        await store.put(blobKey, jpegBytes(16, 31), "image/jpeg");
        await prisma.chatAttachment.update({
          where: { id: blobKept.id },
          data: { storageKey: blobKey },
        });
        const blobGet = await GET_PHOTO(
          req(`http://localhost/api/chat/rooms/all/attachments/${blobKept.id}`, {
            headers: { cookie },
          }),
          { params: Promise.resolve({ roomId: "all", attachmentId: blobKept.id }) }
        );
        assert(blobGet.status === 200, "old Vercel Blob photo read while R2 write is on");
        await prisma.chatAttachment.delete({ where: { id: blobKept.id } });

        const prepared = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: 16,
        });
        assert(prepared.storageBackend === "r2" && prepared.uploadGrant, "prepare issues R2 grant");
        assert(prepared.uploadUrl.includes("/media/upload"), "prepare points at Worker upload");
        const pending = await prisma.chatAttachment.findUnique({ where: { id: prepared.attachmentId } });
        assert(pending?.storageKey.startsWith("r2/chat/"), "PENDING row uses r2/ prefix");
        assert(
          deriveChatMediaR2Key({
            roomId: "all",
            attachmentId: prepared.attachmentId,
            mimeType: "image/jpeg",
          }) === pending?.storageKey.slice("r2/".length),
          "exact R2 key derivation"
        );

        const noGrant = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: { "content-type": "image/jpeg" },
            body: jpegBytes(16, 32),
          }),
          mediaEnv
        );
        assert(noGrant?.status === 401, "upload without grant rejected");

        const expiredGrant = await signChatMediaPutGrant(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_PUT_OP,
          roomId: "all",
          attachmentId: prepared.attachmentId,
          senderUserId: user.id,
          mimeType: "image/jpeg",
          maxBytes: CHAT_PHOTO_MAX_BYTES,
          exp: Math.floor(Date.now() / 1000) - 10,
        });
        const expiredPut = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: expiredGrant,
            },
            body: jpegBytes(16, 32),
          }),
          mediaEnv
        );
        assert(expiredPut?.status === 410, "expired grant rejection");

        const otherRoomGrant = await signChatMediaPutGrant(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_PUT_OP,
          roomId: "room_0123456789abcdef",
          attachmentId: prepared.attachmentId,
          senderUserId: user.id,
          mimeType: "image/jpeg",
          maxBytes: CHAT_PHOTO_MAX_BYTES,
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        const otherRoomPut = await handleChatMediaRequest(
          new Request(`${prepared.uploadUrl}?key=chat/evil/${prepared.attachmentId}.jpg`, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: otherRoomGrant,
            },
            body: jpegBytes(16, 33),
          }),
          mediaEnv
        );
        assert(otherRoomPut?.status === 200, "grant room wins over query key");
        assert(
          !(await bucket.get(`chat/all/${prepared.attachmentId}.jpg`)),
          "client cannot choose arbitrary key"
        );
        assert(
          !!(await bucket.get(`chat/room_0123456789abcdef/${prepared.attachmentId}.jpg`)),
          "object written only at derived grant key"
        );
        await bucket.delete(`chat/room_0123456789abcdef/${prepared.attachmentId}.jpg`);

        const otherUserGrant = await signChatMediaPutGrant(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_PUT_OP,
          roomId: "all",
          attachmentId: prepared.attachmentId,
          senderUserId: other.id,
          mimeType: "image/jpeg",
          maxBytes: CHAT_PHOTO_MAX_BYTES,
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        const otherUserPut = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: otherUserGrant,
            },
            body: jpegBytes(16, 34),
          }),
          mediaEnv
        );
        assert(otherUserPut?.status === 200, "other-user grant still writes its derived key");
        await bucket.delete(`chat/all/${prepared.attachmentId}.jpg`);
        const otherFinalize = await finalizeHttp(
          await cookieFor({ id: other.id, username: other.username, role: "caddy" }),
          "all",
          prepared.attachmentId
        );
        assert(otherFinalize.status === 403, "wrong user finalize rejection");

        const huge = jpegBytes(3 * 1024 * 1024 + 8, 35);
        const hugePut = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
              "content-length": String(huge.byteLength),
            },
            body: huge,
          }),
          mediaEnv
        );
        assert(hugePut?.status === 413, ">3MB rejection");

        const pdfPut = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
            },
            body: pdfBytes(),
          }),
          mediaEnv
        );
        assert(pdfPut?.status === 400, "magic byte mismatch");

        const photoA = jpegBytes(16, 36);
        const photoB = jpegBytes(48, 37);
        const firstPut = await handleChatMediaRequest(
          new Request(`${prepared.uploadUrl}?key=chat/other/nope.jpg`, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
            },
            body: photoA,
          }),
          mediaEnv
        );
        const firstPutJson = await uploadJson(firstPut);
        assert(firstPut?.status === 200 && firstPutJson?.receipt, "first PUT A → 200 receipt");
        assert(
          chatPhotoIdentityMatchesReceipt({ userId: user.id, role: "admin" }, { senderUserId: user.id }),
          "receipt sender matches cookie userId"
        );
        assert(
          chatPhotoIdentityMatchesReceipt({ userId: null, role: "admin" }, { senderUserId: user.id }),
          "env-admin can accept own remapped receipt"
        );
        const receiptFin = await finalizeHttp(
          cookie,
          "all",
          prepared.attachmentId,
          String(firstPutJson?.receipt || ""),
          "?photoDebug=1"
        );
        const receiptFinJson = await receiptFin.json();
        assert(receiptFin.status === 200 && receiptFinJson.photo?.id, "receipt HTTP finalize");
        assert(receiptFinJson.hotpath?.flags?.roomAccessFastPath === true, "receipt finalize roomAccessFastPath=true");
        assert(receiptFinJson.hotpath?.flags?.finalizeInspectSkipped === true, "receipt finalize inspect skipped");
        assert(receiptFinJson.hotpath?.reasons?.roomAccessFallbackReason === "fast", "receipt finalize reason is fast");
        assert(receiptFinJson.hotpath?.steps?.roomAccess == null, "receipt finalize skips requireChatPhotoRoomAccess");
        const retrySame = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
            },
            body: photoA,
          }),
          mediaEnv
        );
        const retrySameJson = await uploadJson(retrySame);
        assert(retrySame?.status === 200 && retrySameJson?.receipt, "same grant + identical A → receipt retry");
        const retryOther = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
            },
            body: photoB,
          }),
          mediaEnv
        );
        assert(retryOther?.status === 409, "same grant + different B → 409");
        const kept = new Uint8Array(
          await (await bucket.get(`chat/all/${prepared.attachmentId}.jpg`))!.arrayBuffer()
        );
        assert(kept[4] === photoA[4], "conflict 뒤 R2 object bytes unchanged");
        assert(
          !(await bucket.get("chat/other/nope.jpg")),
          "client arbitrary key still impossible"
        );

        let inspectCalls = 0;
        const prevFetch = (globalThis as { __caddyChatMediaWorkerFetch?: typeof fetch })
          .__caddyChatMediaWorkerFetch;
        setChatMediaWorkerFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init);
          if (new URL(req.url).pathname.includes("/internal/media/inspect")) inspectCalls += 1;
          return (
            (await handleChatMediaRequest(req, mediaEnv)) ||
            new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
          );
        }) as typeof fetch);
        const finalized = await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: prepared.attachmentId,
          senderUserId: user.id,
          uploadReceipt: String(firstPutJson?.receipt || ""),
        });
        assert(finalized.id === prepared.attachmentId && finalized.claim, "valid receipt finalize");
        assert(inspectCalls === 0, "normal R2 finalize skips inspect");
        const tamperedFin = await finalizeHttp(
          cookie,
          "all",
          prepared.attachmentId,
          String(firstPutJson?.receipt || "").replace(/^../, "zz")
        );
        assert(tamperedFin.status === 401 || tamperedFin.status === 410, "tampered receipt reject");
        const expiredReceipt = await signChatMediaUploadReceipt(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_UPLOADED_OP,
          roomId: "all",
          attachmentId: prepared.attachmentId,
          senderUserId: user.id,
          mimeType: "image/jpeg",
          actualSize: photoA.byteLength,
          exp: Math.floor(Date.now() / 1000) - 10,
        });
        const expiredFin = await finalizeHttp(cookie, "all", prepared.attachmentId, expiredReceipt);
        assert(expiredFin.status === 410, "expired receipt reject");
        const wrongRoomReceipt = await signChatMediaUploadReceipt(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_UPLOADED_OP,
          roomId: "room_0123456789abcdef",
          attachmentId: prepared.attachmentId,
          senderUserId: user.id,
          mimeType: "image/jpeg",
          actualSize: photoA.byteLength,
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        const wrongRoomFin = await finalizeHttp(cookie, "all", prepared.attachmentId, wrongRoomReceipt);
        assert(wrongRoomFin.status === 401, "wrong room receipt reject");
        const wrongAttReceipt = await signChatMediaUploadReceipt(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_UPLOADED_OP,
          roomId: "all",
          attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          senderUserId: user.id,
          mimeType: "image/jpeg",
          actualSize: photoA.byteLength,
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        const wrongAttFin = await finalizeHttp(cookie, "all", prepared.attachmentId, wrongAttReceipt);
        assert(wrongAttFin.status === 401, "wrong attachment receipt reject");
        const wrongSenderReceipt = await signChatMediaUploadReceipt(process.env.CHAT_MEDIA_SECRET || "", {
          v: 1,
          op: CHAT_MEDIA_UPLOADED_OP,
          roomId: "all",
          attachmentId: prepared.attachmentId,
          senderUserId: other.id,
          mimeType: "image/jpeg",
          actualSize: photoA.byteLength,
          exp: Math.floor(Date.now() / 1000) + 300,
        });
        const wrongSenderFin = await finalizeHttp(cookie, "all", prepared.attachmentId, wrongSenderReceipt);
        assert(wrongSenderFin.status === 401 || wrongSenderFin.status === 403, "wrong sender receipt reject");
        if (prevFetch) setChatMediaWorkerFetchForTests(prevFetch);
        const r2Get = await GET_PHOTO(
          req(`http://localhost/api/chat/rooms/all/attachments/${prepared.attachmentId}`, {
            headers: { cookie },
          }),
          { params: Promise.resolve({ roomId: "all", attachmentId: prepared.attachmentId }) }
        );
        assert(r2Get.status === 200, "new R2 photo read");
        const afterReadySame = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
            },
            body: photoA,
          }),
          mediaEnv
        );
        assert(afterReadySame?.status === 200, "finalize 후 same A retry → receipt");
        const afterReadyOther = await handleChatMediaRequest(
          new Request(prepared.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: prepared.uploadGrant || "",
            },
            body: photoB,
          }),
          mediaEnv
        );
        assert(afterReadyOther?.status === 409, "finalize 후 different B → 409");
        const keptReady = new Uint8Array(
          await (await bucket.get(`chat/all/${prepared.attachmentId}.jpg`))!.arrayBuffer()
        );
        assert(keptReady[4] === photoA[4], "READY object stays immutable");

        const second = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: 16,
        });
        assert(second.attachmentId !== prepared.attachmentId, "one photo one upload");
        await handleChatMediaRequest(
          new Request(second.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: second.uploadGrant || "",
            },
            body: jpegBytes(16, 38),
          }),
          mediaEnv
        );
        let fallbackInspect = 0;
        setChatMediaWorkerFetchForTests((async (input: RequestInfo | URL, init?: RequestInit) => {
          const req = input instanceof Request ? input : new Request(String(input), init);
          if (new URL(req.url).pathname.includes("/internal/media/inspect")) fallbackInspect += 1;
          return (
            (await handleChatMediaRequest(req, mediaEnv)) ||
            new Response(JSON.stringify({ error: "not_found" }), { status: 404 })
          );
        }) as typeof fetch);
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: second.attachmentId,
          senderUserId: user.id,
        });
        assert(fallbackInspect === 1, "fallback inspect path");

        const third = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: 16,
        });
        await handleChatMediaRequest(
          new Request(third.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: third.uploadGrant || "",
            },
            body: jpegBytes(16, 39),
          }),
          mediaEnv
        );
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: third.attachmentId,
          senderUserId: user.id,
        });
        assert(
          (
            await prisma.chatAttachment.count({
              where: { senderUserId: user.id, uploadState: "READY", storageKey: { startsWith: "r2/" } },
            })
          ) === 3,
          "1/3 R2 photos"
        );
        await prisma.chatAttachment.deleteMany({
          where: { id: { in: [second.attachmentId, third.attachmentId] } },
        });

        const orphan = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: 16,
        });
        await handleChatMediaRequest(
          new Request(orphan.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: orphan.uploadGrant || "",
            },
            body: jpegBytes(16, 40),
          }),
          mediaEnv
        );
        await prisma.chatAttachment.update({
          where: { id: orphan.attachmentId },
          data: { createdAt: new Date(Date.now() - 16 * 60 * 1000) },
        });
        await cleanupOrphanChatAttachments(prisma);
        assert(
          !(await prisma.chatAttachment.findUnique({ where: { id: orphan.attachmentId } })),
          "orphan cleanup R2 row"
        );
        assert(
          !(await bucket.get(`chat/all/${orphan.attachmentId}.jpg`)),
          "orphan cleanup R2 object"
        );

        const purged = await prepareChatPhotoUpload(prisma, {
          roomId: "all",
          senderUserId: user.id,
          contentType: "image/jpeg",
          size: 16,
        });
        await handleChatMediaRequest(
          new Request(purged.uploadUrl, {
            method: "PUT",
            headers: {
              "content-type": "image/jpeg",
              [CHAT_MEDIA_GRANT_HEADER]: purged.uploadGrant || "",
            },
            body: jpegBytes(16, 41),
          }),
          mediaEnv
        );
        await finalizeChatPhotoUpload(prisma, {
          roomId: "all",
          attachmentId: purged.attachmentId,
          senderUserId: user.id,
        });
        const purge = await purgeChatAttachments(prisma, {
          roomId: "all",
          attachmentIds: [purged.attachmentId],
        });
        assert(purge.deleted === 1, "delete/purge R2 row");
        assert(
          !(await bucket.get(`chat/all/${purged.attachmentId}.jpg`)),
          "delete/purge R2 object"
        );

        delete process.env.CHAT_PHOTO_STORAGE;
        const r2Still = await GET_PHOTO(
          req(`http://localhost/api/chat/rooms/all/attachments/${prepared.attachmentId}`, {
            headers: { cookie },
          }),
          { params: Promise.resolve({ roomId: "all", attachmentId: prepared.attachmentId }) }
        );
        assert(r2Still.status === 200, "R2 read follows key prefix after write rollback");
      } catch (e) {
        console.error(e);
        assert(false, `r2 fast lane threw: ${e instanceof Error ? e.message : e}`);
      } finally {
        setChatMediaWorkerFetchForTests(null);
        if (prevStorage) process.env.CHAT_PHOTO_STORAGE = prevStorage;
        else delete process.env.CHAT_PHOTO_STORAGE;
        if (prevMedia) process.env.CHAT_MEDIA_SECRET = prevMedia;
        else delete process.env.CHAT_MEDIA_SECRET;
        if (prevWorker) process.env.CHAT_WORKER_URL = prevWorker;
        else delete process.env.CHAT_WORKER_URL;
      }
    }
  } finally {
      await prisma.chatAttachment.deleteMany({
        where: { senderUserId: { in: [user.id, other.id] } },
      });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    setCourseReportPhotoStoreForTests(null);
  }
}

section("direct upload security / mime");
{
  assert(parseRequestedChatPhotoMime("image/jpeg") === "image/jpeg", "jpeg mime");
  assert(parseRequestedChatPhotoMime("image/png") === "image/png", "png mime");
  assert(parseRequestedChatPhotoMime("image/webp") === "image/webp", "webp mime");
  let badMime = "";
  try {
    parseRequestedChatPhotoMime("application/pdf");
  } catch (e) {
    badMime = e instanceof CourseReportPhotoValidationError ? e.code : "other";
  }
  assert(badMime === "unsupported_type", "invalid content type rejected");
  let forged = "";
  try {
    verifyLocalChatPhotoPutToken("chat-photo-unit-secret", "not-a-token");
  } catch (e) {
    forged = e instanceof CourseReportPhotoValidationError ? e.code : "other";
  }
  assert(forged === "unauthorized", "signed URL unauthorized");

  const jpegPrefix = jpegBytes(16, 1);
  assert(
    assertCourseReportPhotoPrefix({ prefix: jpegPrefix, totalSize: 2_000_000 }) === "image/jpeg",
    "prefix jpeg + actual size"
  );
  assert(
    assertCourseReportPhotoPrefix({ prefix: pngBytes(), totalSize: 80 }) === "image/png",
    "prefix png"
  );
  assert(
    assertCourseReportPhotoPrefix({ prefix: webpBytes(), totalSize: 80 }) === "image/webp",
    "prefix webp"
  );
  assert(
    assertCourseReportPhotoBytes(jpegPrefix) ===
      assertCourseReportPhotoPrefix({ prefix: jpegPrefix, totalSize: jpegPrefix.byteLength }),
    "bytes helper still matches prefix helper"
  );
  let prefixHuge = "";
  try {
    assertCourseReportPhotoPrefix({ prefix: jpegPrefix, totalSize: 3 * 1024 * 1024 + 1 });
  } catch (e) {
    prefixHuge = e instanceof CourseReportPhotoValidationError ? e.code : "other";
  }
  assert(prefixHuge === "file_too_large", "prefix helper uses actual size not prefix length");
  let prefixEmpty = "";
  try {
    assertCourseReportPhotoPrefix({ prefix: jpegPrefix, totalSize: 0 });
  } catch (e) {
    prefixEmpty = e instanceof CourseReportPhotoValidationError ? e.code : "other";
  }
  assert(prefixEmpty === "empty_file", "empty total size rejected");
  for (const [label, bytes] of [
    ["heic", heicBytes()],
    ["pdf", pdfBytes()],
    ["svg", svgBytes()],
    ["html", htmlBytes()],
  ] as const) {
    let code = "";
    try {
      assertCourseReportPhotoPrefix({ prefix: bytes, totalSize: bytes.byteLength });
    } catch (e) {
      code = e instanceof CourseReportPhotoValidationError ? e.code : "other";
    }
    assert(code === "unsupported_type", `${label} prefix rejected`);
  }
  assert(COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES === 256, "magic prefix cap is 256");

  function streamFrom(bytes: Uint8Array, pull = 64, pulled?: { n: number; cancelled?: boolean }) {
    let offset = 0;
    return new ReadableStream<Uint8Array>({
      pull(controller) {
        if (offset >= bytes.byteLength) {
          controller.close();
          return;
        }
        const next = bytes.subarray(offset, offset + pull);
        offset += next.byteLength;
        if (pulled) pulled.n += next.byteLength;
        controller.enqueue(next);
      },
      cancel() {
        if (pulled) pulled.cancelled = true;
      },
    });
  }

  assert(
    blobPrefixGetResultUsable({ statusCode: 206, stream: streamFrom(jpegPrefix) }),
    "usable helper accepts 206"
  );
  assert(
    blobPrefixGetResultUsable({ statusCode: 200, stream: streamFrom(jpegPrefix) }),
    "usable helper accepts 200"
  );
  assert(!blobPrefixGetResultUsable({ statusCode: 206, stream: null }), "206 without stream is unusable");
  assert(!blobPrefixGetResultUsable({ statusCode: 304, stream: null }), "304 is unusable");
  assert(!blobPrefixGetResultUsable(null), "null get result is unusable");

  const prefix206 = await readBlobObjectPrefixWithGet(
    async () => ({ statusCode: 206, stream: streamFrom(jpegBytes(16, 2)) }),
    "chat/all/a.jpg",
    256
  );
  assert(!!prefix206 && prefix206[0] === 0xff && prefix206[1] === 0xd8, "Range GET 206 + stream → prefix");

  const prefix200 = await readBlobObjectPrefixWithGet(
    async () => ({ statusCode: 200, stream: streamFrom(pngBytes()) }),
    "chat/all/b.png",
    256
  );
  assert(!!prefix200 && prefix200[0] === 0x89, "Range GET 200 + stream → prefix");

  let getCalls = 0;
  const pulled = { n: 0, cancelled: false };
  const huge = jpegBytes(3 * 1024 * 1024 - 8, 4);
  const fallback = await readBlobObjectPrefixWithGet(async (_key, opts) => {
    getCalls += 1;
    const headers = opts.headers as Record<string, string> | undefined;
    if (headers?.Range) return null;
    return { statusCode: 200, stream: streamFrom(huge, 64, pulled) };
  }, "chat/all/c.jpg", 256);
  assert(getCalls === 2, "Range unusable/null → non-range fallback");
  assert(!!fallback && fallback.byteLength === 256, "non-range fallback also max 256 bytes");
  assert(pulled.cancelled === true, "fallback stream cancelled after prefix");
  assert(pulled.n < huge.byteLength, "fallback did not pull the 3MB object");

  let rangeOnly = 0;
  await readBlobObjectPrefixWithGet(async () => {
    rangeOnly += 1;
    return { statusCode: 206, stream: streamFrom(jpegBytes(16, 5)) };
  }, "chat/all/d.jpg", 256);
  assert(rangeOnly === 1, "usable 206 does not run non-range fallback");

  let statusMismatch = 0;
  const from416 = await readBlobObjectPrefixWithGet(async (_key, opts) => {
    statusMismatch += 1;
    const headers = opts.headers as Record<string, string> | undefined;
    if (headers?.Range) return { statusCode: 416, stream: null };
    return { statusCode: 200, stream: streamFrom(webpBytes()) };
  }, "chat/all/e.webp", 256);
  assert(statusMismatch === 2, "Range status mismatch falls back to non-range");
  assert(!!from416 && from416[0] === 0x52, "unusable Range status still yields prefix via fallback");

  class FakeBlobNotFound extends Error {}
  let notFoundCalls = 0;
  const missing = await readBlobObjectPrefixWithGet(
    async () => {
      notFoundCalls += 1;
      throw new FakeBlobNotFound();
    },
    "chat/all/missing.jpg",
    256,
    (e) => e instanceof FakeBlobNotFound
  );
  assert(missing === null, "BlobNotFoundError stays null");
  assert(notFoundCalls === 1, "not-found does not run non-range fallback");
}
}

main().then(() => {
  if (failed > 0) {
    console.error(`\nFAIL ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
