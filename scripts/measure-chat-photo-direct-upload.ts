/**
 * Local timing for Chat Photo Phase 2 (memory store, caddy_local).
 * Not a production Preview measurement. MERGE HOLD / no deploy.
 */
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  finalizeChatPhotoUpload,
  prepareChatPhotoUpload,
  uploadChatPhoto,
} from "../src/lib/chatPhoto";
import { mapBoundedSettled } from "../src/lib/chatPhotoPick";
import {
  createMemoryCourseReportPhotoStore,
  setCourseReportPhotoStoreForTests,
} from "../src/lib/courseReportPhotoStorage";
import { PUT as PUT_LOCAL } from "../src/app/api/chat/local-blob-put/route";
import { NextRequest } from "next/server";

function jpegBytes(extra = 32, mark = 1): Uint8Array {
  const out = new Uint8Array(Math.max(5, 4 + extra));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out[4] = mark;
  return out;
}

async function putSigned(uploadUrl: string, bytes: Uint8Array, contentType: string) {
  const url = new URL(uploadUrl, "http://localhost");
  const res = await PUT_LOCAL(
    new NextRequest(url.href, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: new Uint8Array(bytes),
    })
  );
  if (!res.ok) throw new Error(`local PUT ${res.status}`);
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL || "");
  process.env.CHAT_AUTH_SECRET = process.env.CHAT_AUTH_SECRET || "chat-photo-measure-secret";
  const store = createMemoryCourseReportPhotoStore();
  setCourseReportPhotoStoreForTests(store);
  const tag = `cp_m_${Date.now()}`;
  const user = await prisma.user.create({
    data: {
      username: tag,
      password: await bcrypt.hash("pw123456", 4),
      role: "admin",
      sessionVersion: 0,
    },
  });
  const bytes = jpegBytes(64 * 1024, 3);
  try {
    const before1 = Date.now();
    await uploadChatPhoto(prisma, { roomId: "all", senderUserId: user.id, bytes });
    const before1Ms = Date.now() - before1;

    await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
    const afterStarted = Date.now();
    const p1 = Date.now();
    const prep = await prepareChatPhotoUpload(prisma, {
      roomId: "all",
      senderUserId: user.id,
      contentType: "image/jpeg",
      size: bytes.byteLength,
    });
    const prepareMs = Date.now() - p1;
    const u1 = Date.now();
    await putSigned(prep.uploadUrl, bytes, "image/jpeg");
    const putMs = Date.now() - u1;
    const f1 = Date.now();
    await finalizeChatPhotoUpload(prisma, {
      roomId: "all",
      attachmentId: prep.attachmentId,
      senderUserId: user.id,
    });
    const finalizeMs = Date.now() - f1;
    const after1Ms = Date.now() - afterStarted;

    await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
    const threeBefore = Date.now();
    await mapBoundedSettled([1, 2, 3], 3, async (n) =>
      uploadChatPhoto(prisma, {
        roomId: "all",
        senderUserId: user.id,
        bytes: jpegBytes(64 * 1024, n),
      })
    );
    const threeBeforeMs = Date.now() - threeBefore;

    await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
    const threeAfter = Date.now();
    await mapBoundedSettled([1, 2, 3], 3, async (n) => {
      const prep3 = await prepareChatPhotoUpload(prisma, {
        roomId: "all",
        senderUserId: user.id,
        contentType: "image/jpeg",
        size: bytes.byteLength,
      });
      await putSigned(prep3.uploadUrl, jpegBytes(64 * 1024, 10 + n), "image/jpeg");
      return finalizeChatPhotoUpload(prisma, {
        roomId: "all",
        attachmentId: prep3.attachmentId,
        senderUserId: user.id,
      });
    });
    const threeAfterMs = Date.now() - threeAfter;

    const report = {
      architecture: {
        before: "phone → Vercel Function (full bytes) → Blob",
        after: "phone → Blob signed PUT + small prepare/finalize JSON",
      },
      local_memory_ms: {
        one: {
          before_proxy_helper: before1Ms,
          after_prepare: prepareMs,
          after_direct_put: putMs,
          after_finalize: finalizeMs,
          after_total: after1Ms,
        },
        three: {
          before_proxy_helper: threeBeforeMs,
          after_direct: threeAfterMs,
        },
      },
      note: "Local memory store. Photo bytes no longer enter POST /attachments.",
    };
    console.log(JSON.stringify(report, null, 2));
  } finally {
    await prisma.chatAttachment.deleteMany({ where: { senderUserId: user.id } });
    await prisma.user.delete({ where: { id: user.id } });
    setCourseReportPhotoStoreForTests(null);
    await prisma.$disconnect();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
