/**
 * Notice attachments (PDF / Excel / Hangul). local caddy_local only. Blob mocked.
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
import {
  NOTICE_FILE_HWP_MIME,
  NOTICE_FILE_HWPX_MIME,
  NOTICE_FILE_MAX,
  NOTICE_FILE_MAX_BYTES,
  NOTICE_FILE_PDF_MIME,
  NOTICE_FILE_XLS_MIME,
  NOTICE_FILE_XLSX_MIME,
} from "../src/lib/noticeFileConstants";
import {
  isNoticeFileTableMissing,
  sanitizeNoticeFileName,
} from "../src/lib/noticeFile";
import { assertNoticeFileBytes, assertNoticePdfBytes } from "../src/lib/noticeFileMagic";
import { GET as GET_NOTICE, DELETE as DELETE_NOTICE } from "../src/app/api/notice/[id]/route";
import { POST as POST_NOTICE } from "../src/app/api/notice/route";
import { POST as POST_FILE } from "../src/app/api/notice/[id]/files/route";
import {
  GET as GET_FILE,
  DELETE as DELETE_FILE,
} from "../src/app/api/notice/[id]/files/[fileId]/route";
import { POST as POST_PHOTO } from "../src/app/api/notice/[id]/photos/route";
import { POST as POST_PREPARE } from "../src/app/api/notice/[id]/files/prepare/route";
import { POST as POST_COMPLETE } from "../src/app/api/notice/[id]/files/complete/route";
import { POST as POST_ABORT } from "../src/app/api/notice/[id]/files/abort/route";
import { PUT as PUT_LOCAL } from "../src/app/api/notice/local-blob-put/route";

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

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return (c ^ 0xffffffff) >>> 0;
}

function zipStore(entries: Array<{ name: string; data: string | Uint8Array }>): Uint8Array {
  const files = entries.map((entry) => ({
    name: Buffer.from(entry.name, "utf8"),
    data: typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data),
  }));
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const file of files) {
    const crc = crc32(file.data);
    const local = Buffer.alloc(30 + file.name.length + file.data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(file.data.length, 18);
    local.writeUInt32LE(file.data.length, 22);
    local.writeUInt16LE(file.name.length, 26);
    file.name.copy(local, 30);
    file.data.copy(local, 30 + file.name.length);
    const central = Buffer.alloc(46 + file.name.length);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(file.data.length, 20);
    central.writeUInt32LE(file.data.length, 24);
    central.writeUInt16LE(file.name.length, 28);
    central.writeUInt32LE(offset, 42);
    file.name.copy(central, 46);
    locals.push(local);
    centrals.push(central);
    offset += local.length;
  }
  const cdOffset = offset;
  const cdSize = centrals.reduce((sum, buf) => sum + buf.length, 0);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(files.length, 8);
  eocd.writeUInt16LE(files.length, 10);
  eocd.writeUInt32LE(cdSize, 12);
  eocd.writeUInt32LE(cdOffset, 16);
  return Uint8Array.from(Buffer.concat([...locals, ...centrals, eocd]));
}

function xlsxBytes(): Uint8Array {
  return zipStore([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "xl/workbook.xml", data: "<workbook/>" },
  ]);
}

function hwpxBytes(): Uint8Array {
  return zipStore([
    { name: "mimetype", data: "application/hwp+zip" },
    { name: "Contents/content.hpf", data: "<hpf/>" },
  ]);
}

function docxBytes(): Uint8Array {
  return zipStore([
    { name: "[Content_Types].xml", data: "<Types/>" },
    { name: "word/document.xml", data: "<w:document/>" },
  ]);
}

function oleWithUtf16(names: string[], ascii = ""): Uint8Array {
  const out = new Uint8Array(4096);
  out.set([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1], 0);
  let offset = 512;
  for (const name of names) {
    const encoded = Buffer.from(name, "utf16le");
    out.set(encoded, offset);
    offset += encoded.length + 8;
  }
  if (ascii) out.set(Buffer.from(ascii, "utf8"), offset);
  return out;
}

function xlsBytes(): Uint8Array {
  return oleWithUtf16(["Workbook"]);
}

function hwpBytes(): Uint8Array {
  return oleWithUtf16(["FileHeader"], "HWP Document File");
}

async function postFile(
  cookie: string,
  noticeId: number,
  bytes: Uint8Array,
  name = "안내.pdf",
  type = "application/pdf"
) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type }), name);
  return POST_FILE(
    req(`https://www.verthill.kr/api/notice/${noticeId}/files`, {
      method: "POST",
      headers: cookie ? { cookie } : {},
      body: form,
    }),
    { params: { id: String(noticeId) } }
  );
}

async function prepareFile(
  cookie: string,
  noticeId: number,
  originalName: string,
  contentType: string,
  size: number
) {
  return POST_PREPARE(
    req(`https://www.verthill.kr/api/notice/${noticeId}/files/prepare`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ originalName, contentType, size }),
    }),
    { params: { id: String(noticeId) } }
  );
}

async function putPrepared(uploadUrl: string, bytes: Uint8Array, contentType: string) {
  const url = uploadUrl.startsWith("http")
    ? uploadUrl
    : `https://www.verthill.kr${uploadUrl}`;
  return PUT_LOCAL(
    req(url, {
      method: "PUT",
      headers: { "content-type": contentType },
      body: Buffer.from(bytes),
    })
  );
}

async function completeFile(
  cookie: string,
  noticeId: number,
  grant: string,
  originalName: string,
  sortOrder?: number
) {
  return POST_COMPLETE(
    req(`https://www.verthill.kr/api/notice/${noticeId}/files/complete`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ grant, originalName, sortOrder }),
    }),
    { params: { id: String(noticeId) } }
  );
}

async function abortFile(cookie: string, noticeId: number, grant: string) {
  return POST_ABORT(
    req(`https://www.verthill.kr/api/notice/${noticeId}/files/abort`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({ grant }),
    }),
    { params: { id: String(noticeId) } }
  );
}

async function postPhoto(cookie: string, noticeId: number, bytes: Uint8Array) {
  const form = new FormData();
  form.append("file", new Blob([Buffer.from(bytes)], { type: "image/jpeg" }), "n.jpg");
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
      assert(sanitizeNoticeFileName("주간 안내.docx") === "주간 안내.pdf", "unknown ext stripped");
      assert(sanitizeNoticeFileName("주간 안내.pdf") === "주간 안내.pdf", "hangul pdf name");
      assert(sanitizeNoticeFileName("일정.xlsx", "xlsx") === "일정.xlsx", "xlsx name kept");
      assert(sanitizeNoticeFileName("안내.hwp", "hwp") === "안내.hwp", "hwp name kept");
      assert(sanitizeNoticeFileName("") === "attachment.pdf", "empty fallback");
      assert(assertNoticeFileBytes(xlsxBytes()).ext === "xlsx", "xlsx zip structure ok");
      assert(assertNoticeFileBytes(hwpxBytes()).ext === "hwpx", "hwpx mimetype ok");
      assert(assertNoticeFileBytes(xlsBytes()).ext === "xls", "xls ole workbook ok");
      assert(assertNoticeFileBytes(hwpBytes()).ext === "hwp", "hwp ole header ok");
      let zipRejected = false;
      try {
        assertNoticeFileBytes(zipStore([{ name: "hello.txt", data: "hi" }]), "xlsx");
      } catch {
        zipRejected = true;
      }
      assert(zipRejected, "plain zip rejected as xlsx");
      let docxRejected = false;
      try {
        assertNoticeFileBytes(docxBytes(), "xlsx");
      } catch {
        docxRejected = true;
      }
      assert(docxRejected, "docx rejected as xlsx");
      let xlsxAsPdf = false;
      try {
        assertNoticeFileBytes(xlsxBytes(), "pdf");
      } catch {
        xlsxAsPdf = true;
      }
      assert(xlsxAsPdf, "xlsx rejected as pdf");
      let wordAsXls = false;
      try {
        assertNoticeFileBytes(oleWithUtf16(["WordDocument"]), "xls");
      } catch {
        wordAsXls = true;
      }
      assert(wordAsXls, "word ole rejected as xls");
      let oleOnly = false;
      try {
        assertNoticeFileBytes(oleWithUtf16([]), "hwp");
      } catch {
        oleOnly = true;
      }
      assert(oleOnly, "bare ole rejected as hwp");
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

    section("office types + client upload + spoof + abort");
    {
      const office = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-office`, content: "files" }),
        })
      );
      const officeJson = await office.json();
      noticeIds.push(officeJson.id);

      const xlsxPost = await postFile(
        adminCookie,
        officeJson.id,
        xlsxBytes(),
        "일정.xlsx",
        NOTICE_FILE_XLSX_MIME
      );
      const xlsxPostJson = await xlsxPost.json();
      assert(xlsxPost.status === 200, "xlsx post 200");
      assert(xlsxPostJson.file.mimeType === NOTICE_FILE_XLSX_MIME, "xlsx mime stored");
      assert(xlsxPostJson.file.originalName === "일정.xlsx", "xlsx original name");
      const xlsxRow = await prisma.noticeFile.findUnique({
        where: { id: xlsxPostJson.file.id },
      });
      assert(xlsxRow?.storageKey.endsWith(".xlsx"), "xlsx blob ext");

      const xlsxGet = await GET_FILE(
        req(`https://www.verthill.kr/api/notice/${officeJson.id}/files/${xlsxPostJson.file.id}`, {
          headers: { cookie: caddyCookie },
        }),
        { params: { id: String(officeJson.id), fileId: String(xlsxPostJson.file.id) } }
      );
      assert(xlsxGet.status === 200, "caddy can download xlsx");
      assert(xlsxGet.headers.get("content-type") === NOTICE_FILE_XLSX_MIME, "xlsx content-type");
      assert(
        String(xlsxGet.headers.get("content-disposition") || "").startsWith("attachment"),
        "xlsx not inline"
      );

      const deniedPrep = await prepareFile(
        caddyCookie,
        officeJson.id,
        "a.xlsx",
        NOTICE_FILE_XLSX_MIME,
        xlsxBytes().byteLength
      );
      assert(deniedPrep.status === 403, "caddy cannot prepare");

      const hwpBytesBuf = hwpBytes();
      const prep = await prepareFile(
        adminCookie,
        officeJson.id,
        "안내.hwp",
        NOTICE_FILE_HWP_MIME,
        hwpBytesBuf.byteLength
      );
      const prepJson = await prep.json();
      assert(prep.status === 200, "prepare hwp 200");
      assert(typeof prepJson.upload?.grant === "string", "grant issued");
      assert(prepJson.upload.contentType === NOTICE_FILE_HWP_MIME, "prepare mime bound");
      assert(prepJson.upload.maxBytes === hwpBytesBuf.byteLength, "prepare size bound");
      const put = await putPrepared(
        prepJson.upload.uploadUrl,
        hwpBytesBuf,
        NOTICE_FILE_HWP_MIME
      );
      assert(put.status === 204, "local signed put 204");
      const done = await completeFile(
        adminCookie,
        officeJson.id,
        prepJson.upload.grant,
        "안내.hwp"
      );
      const doneJson = await done.json();
      assert(done.status === 200, "complete hwp 200");
      assert(doneJson.file.originalName === "안내.hwp", "hwp name");
      assert(doneJson.file.mimeType === NOTICE_FILE_HWP_MIME, "hwp mime");
      const replay = await completeFile(
        adminCookie,
        officeJson.id,
        prepJson.upload.grant,
        "안내.hwp"
      );
      const replayJson = await replay.json();
      assert(replay.status === 200, "complete replay 200");
      assert(replayJson.file.id === doneJson.file.id, "complete idempotent");

      const hwpxBuf = hwpxBytes();
      const prepHwpx = await prepareFile(
        adminCookie,
        officeJson.id,
        "공지.hwpx",
        NOTICE_FILE_HWPX_MIME,
        hwpxBuf.byteLength
      );
      const prepHwpxJson = await prepHwpx.json();
      assert(prepHwpx.status === 200, "prepare hwpx 200");
      const putHwpx = await putPrepared(
        prepHwpxJson.upload.uploadUrl,
        hwpxBuf,
        NOTICE_FILE_HWPX_MIME
      );
      assert(putHwpx.status === 204, "hwpx put 204");
      const doneHwpx = await completeFile(
        adminCookie,
        officeJson.id,
        prepHwpxJson.upload.grant,
        "공지.hwpx"
      );
      assert(doneHwpx.status === 200, "complete hwpx 200");

      const spoofPrep = await prepareFile(
        adminCookie,
        officeJson.id,
        "fake.xlsx",
        NOTICE_FILE_XLSX_MIME,
        docxBytes().byteLength
      );
      const spoofPrepJson = await spoofPrep.json();
      assert(spoofPrep.status === 200, "spoof prepare 200");
      const spoofPut = await putPrepared(
        spoofPrepJson.upload.uploadUrl,
        docxBytes(),
        NOTICE_FILE_XLSX_MIME
      );
      assert(spoofPut.status === 204, "spoof put stores bytes");
      const spoofDone = await completeFile(
        adminCookie,
        officeJson.id,
        spoofPrepJson.upload.grant,
        "fake.xlsx"
      );
      assert(spoofDone.status === 400, "docx as xlsx complete rejected");
      assert((await mem.get(spoofPrepJson.upload.storageKey)) == null, "spoof blob deleted");

      const abortPrep = await prepareFile(
        adminCookie,
        officeJson.id,
        "tmp.xls",
        NOTICE_FILE_XLS_MIME,
        xlsBytes().byteLength
      );
      const abortPrepJson = await abortPrep.json();
      const abortPut = await putPrepared(
        abortPrepJson.upload.uploadUrl,
        xlsBytes(),
        NOTICE_FILE_XLS_MIME
      );
      assert(abortPut.status === 204, "abort candidate put");
      const aborted = await abortFile(adminCookie, officeJson.id, abortPrepJson.upload.grant);
      const abortedJson = await aborted.json();
      assert(aborted.status === 200, "abort 200");
      assert(abortedJson.registered === false, "abort not registered");
      assert((await mem.get(abortPrepJson.upload.storageKey)) == null, "abort deletes blob");

      const overPrep = await prepareFile(
        adminCookie,
        officeJson.id,
        "big.xlsx",
        NOTICE_FILE_XLSX_MIME,
        NOTICE_FILE_MAX_BYTES + 1
      );
      assert(overPrep.status === 400, "prepare oversize rejected");

      const pdfAsXlsx = await postFile(
        adminCookie,
        officeJson.id,
        pdfBytes(),
        "no.xlsx",
        NOTICE_FILE_XLSX_MIME
      );
      assert(pdfAsXlsx.status === 400, "pdf bytes rejected as xlsx");
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
      assert(form.includes("NOTICE_FILE_MAX"), "form file max constant");
      assert(form.includes("pickNoticeFiles"), "form file picker");
      assert(form.includes("notice-form-progress"), "form save progress");
      assert(form.includes("pendingFileCount"), "files defer auto-push");
      assert(form.includes("PDF, Excel(.xlsx/.xls), 한글(.hwp/.hwpx)"), "form type hint");
      assert(client.includes("NOTICE_MEDIA_UPLOAD_CONCURRENCY"), "bounded parallel file upload");
      assert(client.includes("/files/prepare"), "client uses blob prepare");
      assert(client.includes("/files/complete"), "client uses blob complete");
      assert(client.includes("/files/abort"), "client aborts failed uploads");
      assert(read("src/lib/noticeMediaLock.ts").includes("FOR UPDATE"), "file inserts lock notice row");
      assert(form.includes("/api/notice/${initial.id}/files/${fileId}"), "admin can delete file");
      assert(form.includes("기존 첨부 파일은 그대로 두었습니다"), "failed upload keeps existing");
      assert(detail.includes("NoticeFileList"), "detail shows file list");
      assert(list.includes("notice-badge-file"), "list file badge");
      assert(list.includes("첨부 {n.fileCount}"), "list badge is generic attachment");
      assert(client.includes("downloadNoticeFile"), "android download helper");
      assert(client.includes("openNoticeFile"), "android open helper");
      assert(client.includes("readCapacitorNativePlatform") || client.includes("native"), "native open fallback");
      assert(client.includes("canInlineNoticeFile"), "non-pdf skips inline open");
      assert(!photoRoute.includes("application/pdf"), "photo API not widened to pdf");
      assert(!read("src/lib/noticePhoto.ts").includes("application/pdf"), "photo helper not pdf");
      assert(!read("src/lib/noticeClipboardPaste.ts").includes("NOTICE_FILE"), "clipboard paste untouched");
      assert(!read("cloudflare/verthill-chat/src/chatMedia.ts").includes("NoticeFile"), "chat worker untouched");
      assert(
        read("src/app/api/notice/local-blob-put/route.ts").includes('process.env.VERCEL === "1"'),
        "local put 404 on vercel"
      );
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
