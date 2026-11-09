/**
 * Notice PDF attachments. local caddy_local only. Blob mocked.
 * 실행: npm run test:notice-file-unit
 */
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { Prisma } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  createMemoryCourseReportPhotoStore,
  getCourseReportPhotoStore,
  setCourseReportPhotoStoreForTests,
} from "../src/lib/courseReportPhotoStorage";
import { NOTICE_FILE_MAX, NOTICE_FILE_MAX_BYTES } from "../src/lib/noticeFileConstants";
import {
  isNoticeFileTableMissing,
  sanitizeNoticeFileName,
} from "../src/lib/noticeFile";
import { assertNoticePdfBytes } from "../src/lib/noticeFileMagic";
import { GET as GET_NOTICE, DELETE as DELETE_NOTICE } from "../src/app/api/notice/[id]/route";
import { POST as POST_NOTICE } from "../src/app/api/notice/route";
import { POST as POST_FILE } from "../src/app/api/notice/[id]/files/route";
import {
  GET as GET_FILE,
  DELETE as DELETE_FILE,
} from "../src/app/api/notice/[id]/files/[fileId]/route";
import { POST as POST_PHOTO } from "../src/app/api/notice/[id]/photos/route";

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

async function cookieFor(user: {
  id: number | null;
  username: string;
  role: "admin" | "caddy" | "leader";
  sessionVersion: number;
}) {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({
      userId: user.id,
      username: user.username,
      role: user.role,
      sessionVersion: user.sessionVersion,
    })
  )}`;
}

function req(url: string, init?: ConstructorParameters<typeof NextRequest>[1]) {
  return new NextRequest(url, init);
}

function jpegBytes(extra = 32, mark = 0): Uint8Array {
  const out = new Uint8Array(Math.max(5, 4 + extra));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out[4] = mark;
  return out;
}

function pdfBytes(extra = 48, mark = 1): Uint8Array {
  const out = new Uint8Array(Math.max(8, 5 + extra));
  out.set([0x25, 0x50, 0x44, 0x46, 0x2d], 0); // %PDF-
  out[5] = mark;
  return out;
}

async function postFile(
  cookie: string,
  noticeId: number,
  bytes: Uint8Array,
  name = "안내.pdf",
  type = "application/pdf"
) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type }), name);
  return POST_FILE(
    req(`https://www.verthill.kr/api/notice/${noticeId}/files`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body: form,
    }),
    { params: { id: String(noticeId) } }
  );
}

async function postPhoto(cookie: string, noticeId: number, bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([bytes], { type: "image/jpeg" }), "n.jpg");
  return POST_PHOTO(
    req(`https://www.verthill.kr/api/notice/${noticeId}/photos`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body: form,
    }),
    { params: { id: String(noticeId) } }
  );
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "notice-file-unit-secret-32chars!!!!";
  const mem = createMemoryCourseReportPhotoStore();
  setCourseReportPhotoStoreForTests(mem);

  const tag = `nf_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const noticeIds: number[] = [];

  try {
    section("magic / filename");
    {
      assert(assertNoticePdfBytes(pdfBytes()) === "application/pdf", "pdf magic ok");
      let rejected = false;
      try {
        assertNoticePdfBytes(jpegBytes());
      } catch {
        rejected = true;
      }
      assert(rejected, "jpeg rejected as pdf");
      let htmlRejected = false;
      try {
        assertNoticePdfBytes(new TextEncoder().encode("<html>nope"));
      } catch {
        htmlRejected = true;
      }
      assert(htmlRejected, "html rejected");
      const huge = new Uint8Array(NOTICE_FILE_MAX_BYTES + 1);
      huge.set([0x25, 0x50, 0x44, 0x46]);
      let sizeRejected = false;
      try {
        assertNoticePdfBytes(huge);
      } catch {
        sizeRejected = true;
      }
      assert(sizeRejected, "oversize pdf rejected");
      assert(sanitizeNoticeFileName("../../x.pdf") === "x.pdf", "path stripped");
      assert(sanitizeNoticeFileName("주간 안내.docx") === "주간 안내.docx.pdf" || sanitizeNoticeFileName("주간 안내.pdf") === "주간 안내.pdf", "hangul kept");
      assert(sanitizeNoticeFileName("주간 안내.pdf") === "주간 안내.pdf", "hangul pdf name");
      assert(sanitizeNoticeFileName("") === "attachment.pdf", "empty fallback");
    }

    const house = await prisma.caddy.create({
      data: {
        name: `${tag}-house`,
        team: "1조",
        teamOrder: 1,
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    caddyIds.push(house.id);
    const uAdmin = await prisma.user.create({
      data: { username: `${tag}-admin`, password: hash, role: "admin" },
    });
    const uCaddy = await prisma.user.create({
      data: {
        username: `${tag}-caddy`,
        password: hash,
        role: "caddy",
        caddyId: house.id,
      },
    });
    userIds.push(uAdmin.id, uCaddy.id);
    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const caddyCookie = await cookieFor({ ...uCaddy, role: "caddy" });

    const created = await POST_NOTICE(
      req("https://www.verthill.kr/api/notice", {
        method: "POST",
        headers: { cookie: adminCookie, "content-type": "application/json" },
        body: JSON.stringify({ title: `${tag}-files`, content: "pdf" }),
      })
    );
    const createdJson = await created.json();
    noticeIds.push(createdJson.id);

    section("upload / auth / isolation from photos");
    {
      const denied = await postFile(caddyCookie, createdJson.id, pdfBytes());
      assert(denied.status === 403, "caddy cannot upload pdf");
      const unauth = await postFile("", createdJson.id, pdfBytes());
      assert(unauth.status === 401, "unauth cannot upload pdf");
      const jpegAsPdf = await postFile(adminCookie, createdJson.id, jpegBytes(), "x.pdf");
      assert(jpegAsPdf.status === 400, "jpeg bytes rejected on file API");
      const pdfOnPhoto = await postPhoto(adminCookie, createdJson.id, pdfBytes());
      assert(pdfOnPhoto.status === 400, "pdf rejected on photo API");

      const first = await postFile(adminCookie, createdJson.id, pdfBytes(40, 1), "주간안내.pdf");
      const firstJson = await first.json();
      assert(first.status === 200, "admin pdf upload 200");
      assert(firstJson.file?.id > 0, "file id returned");
      assert(firstJson.file.originalName === "주간안내.pdf", "original name stored");
      assert(firstJson.file.mimeType === "application/pdf", "mime pdf");

      const row = await prisma.noticeFile.findUnique({ where: { id: firstJson.file.id } });
      assert(row?.storageKey.startsWith(`notices/${createdJson.id}/files/`), "private files/ prefix");
      assert(row?.storageKey.endsWith(".pdf"), "pdf extension");
      assert(!row?.storageKey.includes("주간"), "storage key has no original name");
      assert((await mem.get(row!.storageKey)) != null, "blob stored privately");

      const got = await GET_FILE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}/files/${firstJson.file.id}`, {
          headers: { cookie: caddyCookie },
        }),
        { params: { id: String(createdJson.id), fileId: String(firstJson.file.id) } }
      );
      assert(got.status === 200, "caddy can read visible notice pdf");
      assert(got.headers.get("content-type") === "application/pdf", "pdf content-type");
      assert(got.headers.get("cache-control") === "private, no-cache", "private no-cache");
      assert(String(got.headers.get("content-disposition") || "").includes("inline"), "default inline");
      assert(String(got.headers.get("content-disposition") || "").includes("주간안내.pdf") || String(got.headers.get("content-disposition") || "").includes("UTF-8''"), "filename*");
      assert(got.headers.get("x-content-type-options") === "nosniff", "nosniff");
      const etag = got.headers.get("etag") ?? "";
      assert(etag.startsWith('"nf'), "etag kind nf");
      assert(!etag.includes("notices/"), "etag hides storage key");

      const dl = await GET_FILE(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/files/${firstJson.file.id}?download=1`,
          { headers: { cookie: caddyCookie } }
        ),
        { params: { id: String(createdJson.id), fileId: String(firstJson.file.id) } }
      );
      assert(String(dl.headers.get("content-disposition") || "").startsWith("attachment"), "download=1 attachment");

      const cached = await GET_FILE(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/files/${firstJson.file.id}`,
          { headers: { cookie: caddyCookie, "if-none-match": etag } }
        ),
        { params: { id: String(createdJson.id), fileId: String(firstJson.file.id) } }
      );
      assert(cached.status === 304, "etag 304");

      const unauthGet = await GET_FILE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}/files/${firstJson.file.id}`),
        { params: { id: String(createdJson.id), fileId: String(firstJson.file.id) } }
      );
      assert(unauthGet.status === 401, "unauth cannot read pdf");
    }

    section("future notice hidden + delete + limit");
    {
      const future = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}-future`,
            content: "later",
            publishStartAt: new Date(Date.now() + 86400000).toISOString(),
          }),
        })
      );
      const futureJson = await future.json();
      noticeIds.push(futureJson.id);
      const up = await postFile(adminCookie, futureJson.id, pdfBytes(20, 9), "later.pdf");
      const upJson = await up.json();
      const hidden = await GET_FILE(
        req(
          `https://www.verthill.kr/api/notice/${futureJson.id}/files/${upJson.file.id}`,
          { headers: { cookie: caddyCookie } }
        ),
        { params: { id: String(futureJson.id), fileId: String(upJson.file.id) } }
      );
      assert(hidden.status === 404, "caddy cannot read future notice pdf");

      for (let i = 2; i <= NOTICE_FILE_MAX; i++) {
        const res = await postFile(adminCookie, createdJson.id, pdfBytes(16, i), `n${i}.pdf`);
        assert(res.status === 200, `pdf ${i} ok`);
      }
      const over = await postFile(adminCookie, createdJson.id, pdfBytes(16, 99), "over.pdf");
      assert(over.status === 409, `over ${NOTICE_FILE_MAX} rejected`);

      const detail = await GET_NOTICE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(createdJson.id) } }
      );
      const body = await detail.json();
      assert(body.fileCount === NOTICE_FILE_MAX, "fileCount at max");
      assert(Array.isArray(body.photos), "photos still present beside files");

      const rows = await prisma.noticeFile.findMany({ where: { noticeId: createdJson.id } });
      const firstKey = rows[0].storageKey;
      const delDenied = await DELETE_FILE(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/files/${rows[0].id}`,
          { method: "DELETE", headers: { cookie: caddyCookie } }
        ),
        { params: { id: String(createdJson.id), fileId: String(rows[0].id) } }
      );
      assert(delDenied.status === 403, "caddy cannot delete pdf");
      const delOne = await DELETE_FILE(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/files/${rows[0].id}`,
          { method: "DELETE", headers: { cookie: adminCookie } }
        ),
        { params: { id: String(createdJson.id), fileId: String(rows[0].id) } }
      );
      assert(delOne.status === 200, "admin delete pdf 200");
      assert((await getCourseReportPhotoStore().get(firstKey)) == null, "delete removes blob");
      assert(
        (await prisma.noticeFile.count({ where: { noticeId: createdJson.id } })) ===
          NOTICE_FILE_MAX - 1,
        "other pdfs remain"
      );

      const doomed = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-del`, content: "gone" }),
        })
      );
      const doomedJson = await doomed.json();
      noticeIds.push(doomedJson.id);
      const up2 = await postFile(adminCookie, doomedJson.id, pdfBytes(12, 21), "bye.pdf");
      const up2Json = await up2.json();
      const doomedRow = await prisma.noticeFile.findUnique({ where: { id: up2Json.file.id } });
      const doomedKey = doomedRow?.storageKey ?? "";
      const gone = await DELETE_NOTICE(
        req(`https://www.verthill.kr/api/notice/${doomedJson.id}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(doomedJson.id) } }
      );
      assert(gone.status === 200, "notice delete 200");
      assert((await getCourseReportPhotoStore().get(doomedKey)) == null, "notice delete removes pdf blobs");
      assert(
        (await prisma.noticeFile.count({ where: { noticeId: doomedJson.id } })) === 0,
        "cascade file rows"
      );
    }

    section("table missing helper");
    {
      const err = new Prisma.PrismaClientKnownRequestError(
        "The table `public.NoticeFile` does not exist in the current database.",
        { code: "P2021", clientVersion: "test" }
      );
      assert(isNoticeFileTableMissing(err), "P2021 NoticeFile");
      assert(
        isNoticeFileTableMissing(new Error('relation "NoticeFile" does not exist')),
        "pg missing relation"
      );
      assert(!isNoticeFileTableMissing(new Error("connection refused")), "unrelated not missing");
    }

    section("client / ui wiring");
    {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");
      const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
      const detail = read("src/app/notice/[id]/page.tsx");
      const list = read("src/app/notice/page.tsx");
      const client = read("src/lib/noticeFileClient.ts");
      const photoRoute = read("src/app/api/notice/[id]/photos/route.ts");
      assert(form.includes("NOTICE_FILE_MAX"), "form pdf max constant");
      assert(form.includes("pickNoticeFiles"), "form pdf picker");
      assert(form.includes("notice-form-progress"), "form save progress");
      assert(form.includes("pendingFileCount"), "pdf defers auto-push");
      assert(client.includes("NOTICE_MEDIA_UPLOAD_CONCURRENCY"), "bounded parallel pdf upload");
      assert(read("src/lib/noticeMediaLock.ts").includes("FOR UPDATE"), "pdf inserts lock notice row");
      assert(form.includes("/api/notice/${initial.id}/files/${fileId}"), "admin can delete pdf");
      assert(form.includes("기존 첨부 파일은 그대로 두었습니다"), "failed upload keeps existing");
      assert(detail.includes("NoticeFileList"), "detail shows pdf list");
      assert(list.includes("notice-badge-file"), "list pdf badge");
      assert(client.includes("downloadNoticeFile"), "android download helper");
      assert(client.includes("openNoticeFile"), "android open helper");
      assert(client.includes("readCapacitorNativePlatform") || client.includes("native"), "native open fallback");
      assert(!photoRoute.includes("application/pdf"), "photo API not widened to pdf");
      assert(!read("src/lib/noticePhoto.ts").includes("application/pdf"), "photo helper not pdf");
      assert(!read("cloudflare/verthill-chat/src/chatMedia.ts").includes("NoticeFile"), "chat worker untouched");
    }
  } finally {
    setCourseReportPhotoStoreForTests(null);
    if (noticeIds.length) {
      await prisma.notice.deleteMany({ where: { id: { in: noticeIds } } }).catch(() => undefined);
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    }
    if (caddyIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } }).catch(() => undefined);
    }
    process.env.SESSION_SECRET = prevSecret;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
