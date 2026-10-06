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
  createMemoryCourseReportPhotoStore,
  setCourseReportPhotoStoreForTests,
} from "../src/lib/courseReportPhotoStorage";
import {
  cleanupOrphanChatAttachments,
  consumeChatAttachments,
  loadChatPhotoMeta,
  uploadChatPhoto,
} from "../src/lib/chatPhoto";
import { POST as POST_PHOTO } from "../src/app/api/chat/rooms/[roomId]/attachments/route";
import { GET as GET_PHOTO } from "../src/app/api/chat/rooms/[roomId]/attachments/[attachmentId]/route";
import { POST as POST_CONSUME } from "../src/app/api/chat/attachments/consume/route";
import {
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
  signChatAttachmentClaim,
  validateIncomingMessage,
  verifyChatAttachmentClaim,
} from "../cloudflare/verthill-chat/src/protocol";
import { shouldNotifyChatUser, selectChatPushRecipients } from "../src/lib/chatPushRecipients";
import { buildChatPushPayload } from "../src/lib/chatPushMessage";
import { applyDeletedLine } from "../src/lib/chatPhase4";
import { CourseReportPhotoValidationError } from "../src/lib/courseReportPhotoMagic";

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

section("source wiring / no public blob");
{
  const client = read("src/app/chat/ChatClient.tsx");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  const recipients = read("src/lib/chatPushRecipients.ts");
  const dispatch = read("src/lib/chatPushDispatch.ts");
  const photo = read("src/lib/chatPhoto.ts");
  assert(client.includes("pickChatPhotos"), "composer uses shared prepare/pick");
  assert(client.includes("전송 중..."), "sending copy");
  assert(client.includes("chatPhotoSrc"), "authenticated photo src");
  assert(!client.includes("blob.vercel"), "client has no public blob url");
  assert(photo.includes("chat/${roomId}/"), "chat storage namespace");
  assert(!photo.includes("notices/"), "does not write notice keys");
  assert(!photo.includes("course-reports/"), "does not write report keys");
  assert(worker.includes("attachments_json"), "DO stores metadata json");
  assert(worker.includes("verifyChatAttachmentClaim"), "worker verifies claims");
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
      const form = new FormData();
      form.append("file", new Blob([jpegBytes(12, 7)], { type: "image/jpeg" }), "a.jpg");
      const uploaded = await POST_PHOTO(
        req("http://localhost/api/chat/rooms/all/attachments", {
          method: "POST",
          headers: { cookie },
          body: form,
        }),
        { params: Promise.resolve({ roomId: "all" }) }
      );
      const uploadedJson = await uploaded.json();
      assert(uploaded.status === 200 && uploadedJson.photo?.id, "ALL room member can upload");
      assert(!String(JSON.stringify(uploadedJson)).includes("storageKey"), "response hides storageKey");
      assert(!String(JSON.stringify(uploadedJson)).includes("blob.vercel"), "response hides blob url");

      const custom = await POST_PHOTO(
        req("http://localhost/api/chat/rooms/room_0123456789abcdef/attachments", {
          method: "POST",
          headers: { cookie: otherCookie },
          body: form,
        }),
        { params: Promise.resolve({ roomId: "room_0123456789abcdef" }) }
      );
      assert(custom.status === 403, "non-member upload forbidden");

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
  } finally {
    await prisma.chatAttachment.deleteMany({
      where: { senderUserId: { in: [user.id, other.id] } },
    });
    await prisma.user.deleteMany({ where: { id: { in: [user.id, other.id] } } });
    setCourseReportPhotoStoreForTests(null);
  }
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
