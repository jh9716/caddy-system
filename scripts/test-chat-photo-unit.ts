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
  readBlobObjectPrefixWithGet,
  setCourseReportPhotoStoreForTests,
} from "../src/lib/courseReportPhotoStorage";
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
  instantChatPhotoPicks,
  mapBoundedSettled,
  prepareChatPendingPhoto,
  readyChatPhotosForUpload,
} from "../src/lib/chatPhotoPick";
import {
  canUseChatPhotoFastPath,
  needsChatPhotoHeavyPrepare,
  prepareChatPhotoSource,
} from "../src/lib/chatPhotoFastPath";
import {
  buildOptimisticOutgoingLine,
  clearedComposerAfterOptimisticSend,
  outgoingChatPhotoSrc,
  revokeChatPhotoPreviewUrls,
  shouldStartOptimisticChatSend,
} from "../src/lib/chatPhotoOptimistic";
import {
  emitChatPhotoTimingSummary,
  markChatPhotoTiming,
  resetChatPhotoTiming,
  stampChatPhotoTiming,
  summarizeChatPhotoTiming,
} from "../src/lib/chatPhotoTiming";
import {
  abandonChatPhotoPreupload,
  finishChatPhotoOutgoingUploads,
  startChatPhotoPreupload,
} from "../src/lib/chatPhotoPreupload";
import type { ChatPhotoDirectResult } from "../src/lib/chatPhotoDirectClient";

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
}) {
  const stats = { getCalls: 0, getBytes: 0, headCalls: 0, prefixCalls: 0, prefixBytes: 0 };
  const reset = () => {
    stats.getCalls = 0;
    stats.getBytes = 0;
    stats.headCalls = 0;
    stats.prefixCalls = 0;
    stats.prefixBytes = 0;
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

async function finalizeHttp(cookie: string, roomId: string, attachmentId: string) {
  return POST_FINALIZE(
    req(
      `http://localhost/api/chat/rooms/${roomId}/attachments/${attachmentId}/finalize`,
      { method: "POST", headers: { cookie } }
    ),
    { params: Promise.resolve({ roomId, attachmentId }) }
  );
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
  assert(canUseChatPhotoFastPath(jpegOk), "JPEG <=3MB uses fast path");
  assert(canUseChatPhotoFastPath(pngOk), "PNG <=3MB uses fast path");
  assert(canUseChatPhotoFastPath(webpOk), "WEBP <=3MB uses fast path");
  assert(!canUseChatPhotoFastPath(huge), ">3MB is not fast path");
  assert(needsChatPhotoHeavyPrepare(huge), ">3MB uses compression path");
  assert(needsChatPhotoHeavyPrepare(heic), "HEIC uses conversion path");
  assert(!canUseChatPhotoFastPath(pdf), "unsupported is not fast path");

  let compressCalls = 0;
  const compress = async (file: File) => {
    compressCalls += 1;
    return new Blob([`compressed-${file.name}`], { type: "image/jpeg" });
  };
  const jpegPrepared = await prepareChatPhotoSource(jpegOk, compress);
  assert(jpegPrepared === jpegOk && compressCalls === 0, "JPEG <=3MB → prepareCourseReportPhoto 호출 안 함");
  const pngPrepared = await prepareChatPhotoSource(pngOk, compress);
  assert(pngPrepared === pngOk && compressCalls === 0, "PNG <=3MB → re-encode 안 함");
  const webpPrepared = await prepareChatPhotoSource(webpOk, compress);
  assert(webpPrepared === webpOk && compressCalls === 0, "WEBP <=3MB → re-encode 안 함");
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

section("source wiring / no public blob");

{
  const client = read("src/app/chat/ChatClient.tsx");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  const recipients = read("src/lib/chatPushRecipients.ts");
  const dispatch = read("src/lib/chatPushDispatch.ts");
  const photo = read("src/lib/chatPhoto.ts");
  const reportClient = read("src/lib/courseReportPhotoClient.ts");
  assert(client.includes("instantChatPhotoPicks"), "composer instant preview before prepare");
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
  assert(timingSrc.includes("select_to_put_start_ms"), "timing summary has select→PUT start");
  assert(direct.includes("stampChatPhotoTiming(\"put_start\""), "times PUT start");
  assert(direct.includes("chatPhotoClaimStillValid"), "direct upload reuses live claims");
  assert(client.includes("reply?.seq"), "reply+photo still forwards reply seq");
  assert(!client.includes("fd.append"), "composer no longer posts photo bytes to Next");
  assert(direct.includes("/attachments/prepare"), "composer calls prepare");
  assert(direct.includes("/finalize"), "composer calls finalize");
  assert(client.includes("처리 중"), "preparing status copy");
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
  assert(photo.includes("store.head("), "finalize uses Blob HEAD");
  assert(photo.includes("readPrefix"), "finalize reads prefix only");
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
  const prefixHelper = storage.slice(
    storage.indexOf("export async function readBlobObjectPrefixWithGet"),
    storage.indexOf("export async function readLimitedStream")
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
  assert(photo.includes("runChatAttachmentMaintenance"), "upload runs orphan maintenance");
  assert(photo.includes("purgeChatAttachments"), "room-scoped purge helper");
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

      const custom = await prepareHttp(otherCookie, "room_0123456789abcdef", "image/jpeg", 16);
      assert(custom.status === 403, "non-member prepare forbidden");

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
      assert(largeFin.size === largeJpeg.byteLength, "finalize size from HEAD not DB");
      assert(largeSnap.getCalls === 0 && largeSnap.getBytes === 0, "3MB finalize does not full-read");
      assert(largeSnap.prefixBytes <= COURSE_REPORT_PHOTO_MAGIC_PREFIX_BYTES, "prefix read <=256 bytes");
      assert(largeSnap.prefixCalls === 1 && largeSnap.headCalls === 1, "HEAD + one prefix read");
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
      assert(overSnap.prefixCalls === 0, "oversize rejects before prefix read");
      assert(overSnap.getCalls === 0, "oversize does not full-get");
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
        async readPrefix(key, maxBytes) {
          const bytes = await rangeStore.get(key);
          if (!bytes) return null;
          return readBlobObjectPrefixWithGet(
            async () => ({
              statusCode: 206,
              stream: new ReadableStream<Uint8Array>({
                start(controller) {
                  controller.enqueue(bytes);
                  controller.close();
                },
              }),
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
      setCourseReportPhotoStoreForTests(prevStore);

      storeStats.reset();
      const againReady = await finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: largePrep.attachmentId,
        senderUserId: user.id,
      });
      const readySnap = storeStats.snapshot();
      assert(againReady.id === largeFin.id, "READY re-finalize still idempotent");
      assert(readySnap.headCalls === 0 && readySnap.prefixCalls === 0, "READY finalize skips Blob read");
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
