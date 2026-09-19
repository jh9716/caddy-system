/**
 * CourseReport Photo Upload V1. local caddy_local only. Blob mocked.
 * 실행: npm run test:course-report-photo-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  detectCourseReportPhotoMime,
  assertCourseReportPhotoBytes,
  CourseReportPhotoValidationError,
} from "../src/lib/courseReportPhotoMagic";
import {
  createMemoryCourseReportPhotoStore,
  isCourseReportPhotoStorageConfigured,
  setCourseReportPhotoStoreForTests,
} from "../src/lib/courseReportPhotoStorage";
import { isCourseReportPhotoTableMissing } from "../src/lib/courseReportPhoto";
import { COURSE_REPORT_PHOTO_MAX_BYTES } from "../src/lib/courseReportPhotoConstants";
import { POST as POST_REPORT } from "../src/app/api/course-reports/route";
import { PATCH as PATCH_STATUS } from "../src/app/api/course-reports/[id]/status/route";
import { DELETE as DELETE_REPORT } from "../src/app/api/course-reports/[id]/route";
import { POST as POST_PHOTO } from "../src/app/api/course-reports/[id]/photos/route";
import {
  GET as GET_PHOTO,
  DELETE as DELETE_PHOTO,
} from "../src/app/api/course-reports/[id]/photos/[photoId]/route";

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

function reportParams(id: number) {
  return { params: { id: String(id) } };
}

function photoParams(reportId: number, photoId: number) {
  return { params: { id: String(reportId), photoId: String(photoId) } };
}

async function jsonOf(res: Response) {
  return res.json().catch(() => ({}));
}

function jpegBytes(extra = 32): Uint8Array {
  const out = new Uint8Array(4 + extra);
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  return out;
}

function pngBytes(): Uint8Array {
  return Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);
}

function webpBytes(): Uint8Array {
  const out = new Uint8Array(16);
  out.set([0x52, 0x49, 0x46, 0x46], 0);
  out.set([0x57, 0x45, 0x42, 0x50], 8);
  return out;
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

async function createReport(
  cookie: string,
  title: string
): Promise<number> {
  const res = await POST_REPORT(
    req("https://www.verthill.kr/api/course-reports", {
      method: "POST",
      headers: { cookie, "content-type": "application/json" },
      body: JSON.stringify({
        title,
        body: "본문",
        course: "VERTHILL",
        category: "SAFETY",
      }),
    })
  );
  const body = await jsonOf(res);
  if (res.status !== 200 || typeof body.id !== "number") {
    throw new Error(`create report failed ${res.status}`);
  }
  return body.id as number;
}

async function postPhoto(cookie: string, reportId: number, bytes: Uint8Array) {
  return POST_PHOTO(
    req(`https://www.verthill.kr/api/course-reports/${reportId}/photos`, {
      method: "POST",
      headers: { cookie, "content-type": "application/octet-stream" },
      body: bytes,
    }),
    reportParams(reportId)
  );
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevBlob = process.env.BLOB_READ_WRITE_TOKEN;
  const prevStoreId = process.env.BLOB_STORE_ID;
  const prevOidc = process.env.VERCEL_OIDC_TOKEN;
  const prevVercel = process.env.VERCEL;
  process.env.SESSION_SECRET = "course-report-photo-unit-secret-32ch!";
  delete process.env.BLOB_READ_WRITE_TOKEN;
  delete process.env.BLOB_STORE_ID;
  delete process.env.VERCEL_OIDC_TOKEN;
  delete process.env.VERCEL;
  setCourseReportPhotoStoreForTests(null);

  const tag = `crp_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const reportIds: number[] = [];

  section("source safety");
  {
    const storage = read("src/lib/courseReportPhotoStorage.ts");
    const constants = read("src/lib/courseReportPhotoConstants.ts");
    assert(
      constants.includes("BLOB_READ_WRITE_TOKEN") &&
        storage.includes("COURSE_REPORT_BLOB_TOKEN_ENV"),
      "env name BLOB_READ_WRITE_TOKEN"
    );
    assert(
      constants.includes("BLOB_STORE_ID") &&
        storage.includes("COURSE_REPORT_BLOB_STORE_ID_ENV"),
      "env name BLOB_STORE_ID"
    );
    assert(
      constants.includes("VERCEL_OIDC_TOKEN") &&
        storage.includes("COURSE_REPORT_BLOB_OIDC_TOKEN_ENV"),
      "env name VERCEL_OIDC_TOKEN"
    );
    assert(storage.includes("access: \"private\""), "private blob access");
    assert(!storage.includes("token,"), "sdk calls do not pass token option");
    assert(!/if \(!token\)/.test(storage), "no token-only put/get/del guard");
    assert(!/console\.(log|info|debug|error|warn)/.test(storage), "no storage console logs");
    const form = read("src/app/course-reports/CourseReportForm.tsx");
    assert(form.includes('type="file"'), "form file input");
    assert(
      form.includes("COURSE_REPORT_PHOTO_ACCEPT") &&
        constants.includes("image/jpeg,image/png,image/webp"),
      "accept jpeg/png/webp"
    );
    assert(!form.includes("capture="), "no forced capture");
    assert(form.includes("courseReportPhotoClient"), "client compression module");
    assert(!form.includes("@vercel/blob"), "form no blob sdk");
    assert(!form.includes("courseReportPhotoStorage"), "form no storage import");
    const gallery = read("src/app/course-reports/CourseReportPhotoGallery.tsx");
    assert(
      gallery.includes("courseReportPhotoSrc") &&
        constants.includes("/api/course-reports/"),
      "gallery same-origin src"
    );
    assert(!gallery.includes("blob.vercel"), "gallery no public blob url");
    assert(!gallery.includes("courseReportPhotoStorage"), "gallery no storage");
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("model CourseReportPhoto"), "schema CourseReportPhoto");
    const photoModel = schema.split("model CourseReportPhoto")[1]?.split("model ")[0] ?? "";
    const photoFields = photoModel.replace(/\/\/[^\n]*/g, "");
    assert(!/\bBytes\b/.test(photoFields), "no bytea column");
    assert(!schema.includes("publicUrl"), "no publicUrl column");
    assert(!/\bwidth\b/.test(photoFields), "no width column");
    const mig = read("prisma/migrations/20260918233000_course_report_photo_v1/migration.sql");
    assert(mig.includes('CREATE TABLE "CourseReportPhoto"'), "migration create table");
    assert(mig.includes('CREATE UNIQUE INDEX "CourseReportPhoto_storageKey_key"'), "unique storageKey");
    assert(mig.includes("reportId_sortOrder_idx"), "reportId/sortOrder index");
    assert(mig.includes("ON DELETE CASCADE"), "FK cascade");
    assert(!/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i.test(mig), "migration no DROP");
    const listApi = read("src/app/api/course-reports/route.ts");
    assert(!listApi.includes("storageKey"), "list API no storageKey");
    assert(listApi.includes("listCourseReportsWithPhotoCount"), "list API photo-table fail-soft");
    const listPage = read("src/app/course-reports/page.tsx");
    assert(!listPage.includes("<img"), "list no eager photo img");
    assert(listPage.includes("listCourseReportsWithPhotoCount"), "list page photo-table fail-soft");
    const detailPage = read("src/app/course-reports/[id]/page.tsx");
    assert(detailPage.includes("findCourseReportWithPhotos"), "detail photo-table fail-soft");
    assert(listPage.includes("photoCount"), "list shows photoCount");
    const photoGet = read("src/app/api/course-reports/[id]/photos/[photoId]/route.ts");
    assert(photoGet.includes("requireCourseReportReader"), "photo GET reuses reader auth");
    assert(photoGet.includes("Cache-Control"), "private cache header");
    const deploy = read("scripts/maintenance/deploy-course-report-photo-v1-migration.ts");
    assert(deploy.includes("COURSE_REPORT_PHOTO_V1_20260919"), "maintenance confirm task-id");
    assert(deploy.includes('["migrate", "deploy"]'), "maintenance migrate deploy only");
    assert(!deploy.includes('["migrate", "reset"]'), "maintenance no reset call");
    assert(!deploy.includes('["migrate", "dev"]'), "maintenance no migrate dev call");
  }

  section("magic bytes");
  {
    assert(detectCourseReportPhotoMime(jpegBytes()) === "image/jpeg", "jpeg magic");
    assert(detectCourseReportPhotoMime(pngBytes()) === "image/png", "png magic");
    assert(detectCourseReportPhotoMime(webpBytes()) === "image/webp", "webp magic");
    assert(detectCourseReportPhotoMime(Uint8Array.from([1, 2, 3, 4])) === null, "fake not image");
    try {
      assertCourseReportPhotoBytes(new TextEncoder().encode("<svg xmlns='x'></svg>"));
      assert(false, "svg rejected");
    } catch (e) {
      assert(e instanceof CourseReportPhotoValidationError, "svg error type");
    }
    try {
      assertCourseReportPhotoBytes(new TextEncoder().encode("%PDF-1.4"));
      assert(false, "pdf rejected");
    } catch (e) {
      assert(e instanceof CourseReportPhotoValidationError, "pdf error type");
    }
    try {
      assertCourseReportPhotoBytes(heicBytes());
      assert(false, "heic rejected");
    } catch (e) {
      assert(e instanceof CourseReportPhotoValidationError, "heic error type");
    }
    const huge = new Uint8Array(COURSE_REPORT_PHOTO_MAX_BYTES + 1);
    huge.set([0xff, 0xd8, 0xff], 0);
    try {
      assertCourseReportPhotoBytes(huge);
      assert(false, "oversize rejected");
    } catch (e) {
      assert(
        e instanceof CourseReportPhotoValidationError && e.code === "file_too_large",
        "oversize code"
      );
    }
    assert(
      isCourseReportPhotoTableMissing(
        new Error('The table `public.CourseReportPhoto` does not exist in the current database.')
      ),
      "missing table helper true"
    );
    assert(
      !isCourseReportPhotoTableMissing(new Error("connection refused")),
      "missing table helper false"
    );
  }

  section("storage auth detection");
  {
    assert(!isCourseReportPhotoStorageConfigured(), "empty env unconfigured");
    process.env.BLOB_READ_WRITE_TOKEN = "vercel_blob_rw_unit_dummy";
    assert(isCourseReportPhotoStorageConfigured(), "legacy token configured");
    delete process.env.BLOB_READ_WRITE_TOKEN;
    process.env.BLOB_STORE_ID = "store_unit_dummy";
    assert(!isCourseReportPhotoStorageConfigured(), "store id alone unconfigured");
    process.env.VERCEL_OIDC_TOKEN = "oidc_unit_dummy";
    assert(isCourseReportPhotoStorageConfigured(), "OIDC env + store id configured");
    delete process.env.VERCEL_OIDC_TOKEN;
    process.env.VERCEL = "1";
    assert(isCourseReportPhotoStorageConfigured(), "Vercel runtime + store id configured");
    delete process.env.BLOB_STORE_ID;
    assert(!isCourseReportPhotoStorageConfigured(), "Vercel without store unconfigured");
    delete process.env.VERCEL;
    delete process.env.BLOB_READ_WRITE_TOKEN;
    delete process.env.BLOB_STORE_ID;
    delete process.env.VERCEL_OIDC_TOKEN;
  }

  try {
    const caddy = await prisma.caddy.create({
      data: { name: `${tag}_caddy`, team: "1조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    const otherC = await prisma.caddy.create({
      data: { name: `${tag}_other`, team: "2조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    const retiredC = await prisma.caddy.create({
      data: { name: `${tag}_ret`, team: "1조", caddyType: "HOUSE", employmentStatus: "RETIRED" },
    });
    caddyIds.push(caddy.id, otherC.id, retiredC.id);
    const uAdmin = await prisma.user.create({
      data: { username: `${tag}_admin`, password: hash, role: "admin", sessionVersion: 0 },
    });
    const uCaddy = await prisma.user.create({
      data: {
        username: `${tag}_caddy`,
        password: hash,
        role: "caddy",
        caddyId: caddy.id,
        sessionVersion: 0,
      },
    });
    const uOther = await prisma.user.create({
      data: {
        username: `${tag}_other`,
        password: hash,
        role: "caddy",
        caddyId: otherC.id,
        sessionVersion: 0,
      },
    });
    const uRetired = await prisma.user.create({
      data: {
        username: `${tag}_ret`,
        password: hash,
        role: "caddy",
        caddyId: retiredC.id,
        sessionVersion: 0,
      },
    });
    userIds.push(uAdmin.id, uCaddy.id, uOther.id, uRetired.id);
    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const caddyCookie = await cookieFor({ ...uCaddy, role: "caddy" });
    const otherCookie = await cookieFor({ ...uOther, role: "caddy" });
    const retiredCookie = await cookieFor({ ...uRetired, role: "caddy" });

    const ownId = await createReport(caddyCookie, `${tag}_own`);
    const otherId = await createReport(otherCookie, `${tag}_other`);
    reportIds.push(ownId, otherId);

    section("unauth / RETIRED");
    {
      const up = await postPhoto("", ownId, jpegBytes());
      assert(up.status === 401, "unauth upload 401");
      const get = await GET_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/photos/1`),
        photoParams(ownId, 1)
      );
      assert(get.status === 401, "unauth read 401");
      const del = await DELETE_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/photos/1`, {
          method: "DELETE",
        }),
        photoParams(ownId, 1)
      );
      assert(del.status === 401, "unauth delete 401");
      const ret = await postPhoto(retiredCookie, ownId, jpegBytes());
      assert(ret.status === 401, "RETIRED upload 401");
    }

    section("storage unconfigured");
    {
      const res = await postPhoto(caddyCookie, ownId, jpegBytes());
      const body = await jsonOf(res);
      assert(res.status === 503, "unconfigured 503");
      assert(body.error === "storage_not_configured", "unconfigured code");
      const n = await prisma.courseReportPhoto.count({ where: { reportId: ownId } });
      assert(n === 0, "unconfigured DB row 0");
    }

    const mem = createMemoryCourseReportPhotoStore();
    setCourseReportPhotoStoreForTests(mem);

    section("upload success + types");
    {
      const jpeg = await postPhoto(caddyCookie, ownId, jpegBytes());
      const jpegBody = await jsonOf(jpeg);
      assert(jpeg.status === 200, "caddy own RECEIVED jpeg 200");
      assert(typeof jpegBody.photo?.id === "number", "photo id");
      assert(jpegBody.photo.mimeType === "image/jpeg", "jpeg mime");
      assert(!JSON.stringify(jpegBody).includes("storageKey"), "response no storageKey");
      assert(!JSON.stringify(jpegBody).includes("BLOB"), "response no token");
      const png = await postPhoto(caddyCookie, ownId, pngBytes());
      assert(png.status === 200, "png 200");
      const webp = await postPhoto(caddyCookie, ownId, webpBytes());
      assert(webp.status === 200, "webp 200");
      const fourth = await postPhoto(caddyCookie, ownId, jpegBytes());
      assert(fourth.status === 409, "4th 409");
      const n = await prisma.courseReportPhoto.count({ where: { reportId: ownId } });
      assert(n === 3, "max 3 stored");
    }

    section("rejects");
    {
      const otherReport = otherId;
      const fake = await postPhoto(caddyCookie, otherReport, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8]));
      assert((await jsonOf(fake)).error === "forbidden" || fake.status === 403, "other report blocked before type or 403");
      const fakeJpg = await postPhoto(
        adminCookie,
        otherId,
        Uint8Array.from([0xff, 0xd8, 0x00, 0x01, 0x02, 0x03, 0x04, 0x05])
      );
      assert(fakeJpg.status === 400, "fake jpg 400");
      const svg = await postPhoto(adminCookie, otherId, new TextEncoder().encode("<svg xmlns='http://www.w3.org/2000/svg'></svg>"));
      assert(svg.status === 400, "svg 400");
      const html = await postPhoto(
        adminCookie,
        otherId,
        new TextEncoder().encode("<!DOCTYPE html><html><body>x</body></html>")
      );
      assert(html.status === 400, "html 400");
      const pdf = await postPhoto(adminCookie, otherId, new TextEncoder().encode("%PDF-1.4\n%"));
      assert(pdf.status === 400, "pdf 400");
      const heic = await postPhoto(adminCookie, otherId, heicBytes());
      assert(heic.status === 400, "heic 400");
      const huge = new Uint8Array(COURSE_REPORT_PHOTO_MAX_BYTES + 8);
      huge.set([0xff, 0xd8, 0xff], 0);
      const over = await postPhoto(adminCookie, otherId, huge);
      assert(over.status === 400, "3MB+ 400");
    }

    section("permissions");
    {
      const otherUp = await postPhoto(caddyCookie, otherId, jpegBytes());
      assert(otherUp.status === 403, "other caddy upload 403");
      const adminUp = await postPhoto(adminCookie, otherId, jpegBytes());
      const adminBody = await jsonOf(adminUp);
      assert(adminUp.status === 200, "admin upload 200");
      const adminPhotoId = adminBody.photo.id as number;
      const otherDel = await DELETE_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${otherId}/photos/${adminPhotoId}`, {
          method: "DELETE",
          headers: { cookie: caddyCookie },
        }),
        photoParams(otherId, adminPhotoId)
      );
      assert(otherDel.status === 403, "other caddy delete 403");
      const adminDel = await DELETE_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${otherId}/photos/${adminPhotoId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        photoParams(otherId, adminPhotoId)
      );
      assert(adminDel.status === 200, "admin delete 200");
    }

    section("CHECKING/RESOLVED author blocked");
    {
      await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "CHECKING" }),
        }),
        reportParams(ownId)
      );
      const checkingUp = await postPhoto(caddyCookie, ownId, jpegBytes());
      assert(checkingUp.status === 403, "CHECKING author upload 403");
      const photos = await prisma.courseReportPhoto.findMany({ where: { reportId: ownId } });
      const delChecking = await DELETE_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/photos/${photos[0].id}`, {
          method: "DELETE",
          headers: { cookie: caddyCookie },
        }),
        photoParams(ownId, photos[0].id)
      );
      assert(delChecking.status === 403, "CHECKING author delete 403");
      const adminStill = await postPhoto(adminCookie, ownId, jpegBytes());
      assert(adminStill.status === 409 || adminStill.status === 200, "admin still allowed or at cap");
      await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "RESOLVED" }),
        }),
        reportParams(ownId)
      );
      const resolvedUp = await postPhoto(caddyCookie, ownId, jpegBytes());
      assert(resolvedUp.status === 403, "RESOLVED author upload 403");
      await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "RECEIVED" }),
        }),
        reportParams(ownId)
      );
    }

    section("read / cross-report / soft-delete");
    {
      const photos = await prisma.courseReportPhoto.findMany({
        where: { reportId: ownId },
        orderBy: { id: "asc" },
      });
      const photoId = photos[0].id;
      const got = await GET_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/photos/${photoId}`, {
          headers: { cookie: caddyCookie },
        }),
        photoParams(ownId, photoId)
      );
      assert(got.status === 200, "owner get photo 200");
      assert(got.headers.get("content-type") === "image/jpeg", "content-type jpeg");
      const wrong = await GET_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${otherId}/photos/${photoId}`, {
          headers: { cookie: caddyCookie },
        }),
        photoParams(otherId, photoId)
      );
      assert(wrong.status === 404, "other report photo 404");
      const failStore = createMemoryCourseReportPhotoStore();
      failStore.put = async () => {
        throw new Error("put fail");
      };
      setCourseReportPhotoStoreForTests(failStore);
      const before = await prisma.courseReportPhoto.count({ where: { reportId: otherId } });
      const failUp = await postPhoto(adminCookie, otherId, jpegBytes());
      assert(failUp.status === 502, "put fail 502");
      const after = await prisma.courseReportPhoto.count({ where: { reportId: otherId } });
      assert(after === before, "put fail no photo row");
      setCourseReportPhotoStoreForTests(mem);

      await DELETE_REPORT(
        req(`https://www.verthill.kr/api/course-reports/${ownId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        reportParams(ownId)
      );
      const afterSoft = await GET_PHOTO(
        req(`https://www.verthill.kr/api/course-reports/${ownId}/photos/${photoId}`, {
          headers: { cookie: adminCookie },
        }),
        photoParams(ownId, photoId)
      );
      assert(afterSoft.status === 404, "soft-deleted report photo 404");
      const still = await prisma.courseReportPhoto.count({ where: { reportId: ownId } });
      assert(still === photos.length, "soft delete keeps photo rows");
    }
  } finally {
    setCourseReportPhotoStoreForTests(null);
    if (prevBlob === undefined) delete process.env.BLOB_READ_WRITE_TOKEN;
    else process.env.BLOB_READ_WRITE_TOKEN = prevBlob;
    if (prevStoreId === undefined) delete process.env.BLOB_STORE_ID;
    else process.env.BLOB_STORE_ID = prevStoreId;
    if (prevOidc === undefined) delete process.env.VERCEL_OIDC_TOKEN;
    else process.env.VERCEL_OIDC_TOKEN = prevOidc;
    if (prevVercel === undefined) delete process.env.VERCEL;
    else process.env.VERCEL = prevVercel;
    process.env.SESSION_SECRET = prevSecret;
    if (reportIds.length) {
      await prisma.courseReportPhoto.deleteMany({ where: { reportId: { in: reportIds } } });
      await prisma.courseReport.deleteMany({ where: { id: { in: reportIds } } });
    }
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (caddyIds.length) await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
