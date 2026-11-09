/**
 * Notice photo upload. local caddy_local only. Blob mocked.
 * 실행: npm run test:notice-photo-unit
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
import { NOTICE_PHOTO_MAX } from "../src/lib/noticePhotoConstants";
import { deleteNoticePhoto, isNoticePhotoTableMissing } from "../src/lib/noticePhoto";
import { CourseReportPhotoStorageError } from "../src/lib/courseReportPhotoStorage";
import {
  DELETE as DELETE_NOTICE,
  GET as GET_NOTICE,
  PATCH as PATCH_NOTICE,
} from "../src/app/api/notice/[id]/route";
import { GET as GET_NOTICE_LIST, POST as POST_NOTICE } from "../src/app/api/notice/route";
import { POST as POST_PHOTO } from "../src/app/api/notice/[id]/photos/route";
import {
  GET as GET_PHOTO,
  DELETE as DELETE_PHOTO,
} from "../src/app/api/notice/[id]/photos/[photoId]/route";

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

function passthroughNoticeTransaction() {
  const orig = prisma.$transaction.bind(prisma);
  prisma.$transaction = (async (arg: unknown, options?: unknown) => {
    if (typeof arg === "function") return (arg as (tx: typeof prisma) => Promise<unknown>)(prisma);
    return orig(arg as never, options as never);
  }) as typeof prisma.$transaction;
  return () => {
    prisma.$transaction = orig;
  };
}

function adminAuth(user: { id: number; username: string }) {
  return {
    session: {} as never,
    userId: user.id,
    username: user.username,
    role: "admin" as const,
    sessionVersion: 0,
    caddyId: null,
    managedTeams: [] as string[],
    mustChangePassword: false,
  };
}

function noticePhotoTableMissingError() {
  return new Prisma.PrismaClientKnownRequestError(
    "The table `public.NoticePhoto` does not exist in the current database.",
    { code: "P2021", clientVersion: "test" }
  );
}

function jpegBytes(extra = 32, mark = 0): Uint8Array {
  const out = new Uint8Array(Math.max(5, 4 + extra));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out[4] = mark;
  return out;
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
  section("notice photo limits are independent");
  {
    const fs = await import("node:fs");
    const path = await import("node:path");
    const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");
    const constants = read("src/lib/noticePhotoConstants.ts");
    const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
    const noticeClient = read("src/lib/noticePhotoClient.ts");
    const reportClient = read("src/lib/courseReportPhotoClient.ts");
    const chatClient = read("src/lib/chatPhotoClient.ts");
    assert(NOTICE_PHOTO_MAX === 10, "notice max 10");
    assert(constants.includes("NOTICE_PHOTO_MAX = 10"), "constant 10");
    assert(!constants.includes("NOTICE_PHOTO_MAX = COURSE_REPORT_PHOTO_MAX"), "notice max not aliased");
    assert(form.includes("NOTICE_PHOTO_MAX"), "form uses notice max");
    assert(!form.includes("COURSE_REPORT_PHOTO_MAX"), "form does not use report max");
    assert(form.includes("instantNoticePhotoPicks"), "form instant thumbs before encode");
    assert(form.includes('className="is-revealed"'), "form reveals composer thumbs");
    assert(form.includes("notice-form-progress"), "form shows save progress");
    assert(form.includes("submitLock"), "form double-submit lock");
    assert(!form.includes("pickNoticePhotos("), "form does not block pick on encode");
    assert(noticeClient.includes("prepareNoticePhoto"), "notice client has dedicated prepare");
    assert(noticeClient.includes("instantNoticePhotoPicks"), "picker shows original file immediately");
    assert(!noticeClient.includes("pickCourseReportPhotos(files, room, prepareNoticePhoto"), "does not reuse report picker");
    assert(noticeClient.includes("NOTICE_MEDIA_UPLOAD_CONCURRENCY"), "bounded parallel photo upload");
    assert(read("src/lib/noticeMediaLock.ts").includes("FOR UPDATE"), "parallel inserts lock notice row");
    assert(read("src/app/globals.css").includes(".notice-form .course-report-photo-item img"), "notice form thumb opacity override");
    assert(reportClient.includes("COURSE_REPORT_PHOTO_LONG_EDGE"), "report still uses 1200-edge encode");
    assert(reportClient.includes("COURSE_REPORT_PHOTO_JPEG_QUALITY"), "report quality unchanged");
    assert(chatClient.includes("prepareCourseReportPhoto as prepareChatPhoto"), "chat still uses report prepare");

    const { parseRequestedSortOrder, resolveLockedSortOrder } = await import(
      "../src/lib/noticeMediaLock"
    );
    assert(parseRequestedSortOrder("3") === 3, "sortOrder form field parsed");
    assert(parseRequestedSortOrder("nope") == null, "invalid sortOrder ignored");
    assert(resolveLockedSortOrder(1, 3, false) === 3, "requested sort kept when free");
    assert(resolveLockedSortOrder(1, 3, true) === 2, "taken sort falls back to max+1");

    const {
      instantNoticePhotoPicks,
      uploadNoticePendingPhotos,
      NOTICE_MEDIA_UPLOAD_CONCURRENCY,
    } = await import("../src/lib/noticePhotoClient");
    assert(NOTICE_MEDIA_UPLOAD_CONCURRENCY === 3, "photo upload concurrency 3");
    const jpegFile = new File([jpegBytes()], "a.jpg", { type: "image/jpeg" });
    const instant = instantNoticePhotoPicks([jpegFile], 10);
    assert(instant.items.length === 1, "instant pick keeps jpeg");
    assert(instant.items[0].status === "preparing", "thumb before encode");
    assert(instant.items[0].previewUrl.startsWith("blob:"), "object URL from original file");
    const heic = instantNoticePhotoPicks(
      [new File([jpegBytes()], "b.heic", { type: "image/heic" })],
      10
    );
    assert(heic.items[0].previewUrl === "", "heic waits for convert before object URL");

    const delayMs = 90;
    let inFlight = 0;
    let maxInFlight = 0;
    const slowPost = (async () => {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      await new Promise((r) => setTimeout(r, delayMs));
      inFlight -= 1;
      return new Response(JSON.stringify({ photo: { id: 1 } }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }) as typeof fetch;
    const six = Array.from({ length: 6 }, () => ({ blob: new Blob(["x"]) }));
    const t0 = Date.now();
    const parallelUp = await uploadNoticePendingPhotos(1, six, slowPost);
    const parallelMs = Date.now() - t0;
    assert(parallelUp.uploaded === 6 && parallelUp.failed === 0, "6 mock photos uploaded");
    assert(maxInFlight <= NOTICE_MEDIA_UPLOAD_CONCURRENCY, "caps concurrent photo POSTs at 3");
    assert(maxInFlight >= 2, "uses more than one upload at a time");
    assert(parallelMs < delayMs * 6 * 0.7, "bounded parallel faster than sequential 6");
    console.log(
      `  measured client upload: 6 photos delay=${delayMs}ms concurrency=${NOTICE_MEDIA_UPLOAD_CONCURRENCY} wall=${parallelMs}ms (sequential estimate ${delayMs * 6}ms)`
    );
  }

  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "notice-photo-unit-secret-32chars!!!";
  const mem = createMemoryCourseReportPhotoStore();
  let blobGets = 0;
  setCourseReportPhotoStoreForTests({
    ...mem,
    async get(key) {
      blobGets += 1;
      return mem.get(key);
    },
  });

  const tag = `np_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const noticeIds: number[] = [];

  try {
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
        body: JSON.stringify({ title: `${tag}-plain`, content: "no photo" }),
      })
    );
    const createdJson = await created.json();
    noticeIds.push(createdJson.id);

    section("existing notice without photos");
    {
      const detail = await GET_NOTICE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(createdJson.id) } }
      );
      const body = await detail.json();
      assert(detail.status === 200, "notice without photos still 200");
      assert(Array.isArray(body.photos) && body.photos.length === 0, "photos []");
      assert(body.photoCount === 0, "photoCount 0");
      assert(Array.isArray(body.files) && body.files.length === 0, "files []");
      assert(body.fileCount === 0, "fileCount 0");
    }

    section("admin upload / caddy blocked");
    {
      const denied = await postPhoto(caddyCookie, createdJson.id, jpegBytes());
      assert(denied.status === 403, "caddy cannot upload notice photo");
      const unauth = await postPhoto("", createdJson.id, jpegBytes());
      assert(unauth.status === 401, "unauth cannot upload");

      const first = await postPhoto(adminCookie, createdJson.id, jpegBytes(32, 1));
      const firstJson = await first.json();
      assert(first.status === 200, "admin upload 200");
      assert(firstJson.photo?.id > 0, "photo id returned");

      const got = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/photos/${firstJson.photo.id}`,
          { headers: { cookie: caddyCookie } }
        ),
        { params: { id: String(createdJson.id), photoId: String(firstJson.photo.id) } }
      );
      assert(got.status === 200, "caddy can read visible notice photo");
      assert(got.headers.get("content-type") === "image/jpeg", "jpeg content-type");
      assert(got.headers.get("cache-control") === "private, no-cache", "private no-cache");
      const gotBytes = await got.clone().arrayBuffer();
      assert(got.headers.get("content-length") === String(gotBytes.byteLength), "known body sets content-length");
      assert(String(got.headers.get("server-timing") || "").includes("auth"), "server-timing auth");
      const etag = got.headers.get("etag");
      assert(Boolean(etag) && etag?.startsWith('"n'), "etag from notice metadata");
      assert(!String(etag).includes("notices/"), "etag does not leak storageKey");

      const getsBefore = blobGets;
      const cached = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/photos/${firstJson.photo.id}`,
          { headers: { cookie: caddyCookie, "if-none-match": etag } }
        ),
        { params: { id: String(createdJson.id), photoId: String(firstJson.photo.id) } }
      );
      assert(cached.status === 304, "matching etag 304 after auth");
      assert((await cached.arrayBuffer()).byteLength === 0, "304 body empty");
      assert(cached.headers.get("etag") === etag, "304 repeats etag");
      assert(cached.headers.get("cache-control") === "private, no-cache", "304 keeps no-cache");
      assert(blobGets === getsBefore, "304 does not Blob get");

      const stale = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/photos/${firstJson.photo.id}`,
          { headers: { cookie: caddyCookie, "if-none-match": '"n0-0-deadbeef"' } }
        ),
        { params: { id: String(createdJson.id), photoId: String(firstJson.photo.id) } }
      );
      assert(stale.status === 200, "mismatch etag 200");
      assert((await stale.arrayBuffer()).byteLength > 0, "mismatch returns body");
      assert(blobGets === getsBefore + 1, "mismatch Blob gets once");

      const unauth304 = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/photos/${firstJson.photo.id}`,
          { headers: { "if-none-match": etag } }
        ),
        { params: { id: String(createdJson.id), photoId: String(firstJson.photo.id) } }
      );
      assert(unauth304.status === 401, "unauth never 304");
      assert(unauth304.status !== 304, "unauth status is not 304");

      const delDenied = await DELETE_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/photos/${firstJson.photo.id}`,
          { method: "DELETE", headers: { cookie: caddyCookie } }
        ),
        { params: { id: String(createdJson.id), photoId: String(firstJson.photo.id) } }
      );
      assert(delDenied.status === 403, "caddy cannot delete notice photo");
    }

    section("multi photo + limit");
    {
      for (let i = 2; i <= NOTICE_PHOTO_MAX; i++) {
        const res = await postPhoto(adminCookie, createdJson.id, jpegBytes(32, i));
        assert(res.status === 200, `photo ${i} ok`);
      }
      const over = await postPhoto(adminCookie, createdJson.id, jpegBytes(32, 99));
      assert(over.status === 409, `over ${NOTICE_PHOTO_MAX} rejected`);
      const detail = await GET_NOTICE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(createdJson.id) } }
      );
      const body = await detail.json();
      assert(body.photos.length === NOTICE_PHOTO_MAX, `${NOTICE_PHOTO_MAX} photos listed`);
      assert(body.photoCount === NOTICE_PHOTO_MAX, `photoCount ${NOTICE_PHOTO_MAX}`);
    }

    section("future notice photo hidden from caddy");
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
      const up = await postPhoto(adminCookie, futureJson.id, jpegBytes(32, 9));
      const upJson = await up.json();
      const hidden = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${futureJson.id}/photos/${upJson.photo.id}`,
          { headers: { cookie: caddyCookie } }
        ),
        { params: { id: String(futureJson.id), photoId: String(upJson.photo.id) } }
      );
      assert(hidden.status === 404, "caddy cannot read future notice photo");
      const adminGot = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${futureJson.id}/photos/${upJson.photo.id}`,
          { headers: { cookie: adminCookie } }
        ),
        { params: { id: String(futureJson.id), photoId: String(upJson.photo.id) } }
      );
      const futureEtag = adminGot.headers.get("etag") ?? "";
      const hiddenCached = await GET_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${futureJson.id}/photos/${upJson.photo.id}`,
          { headers: { cookie: caddyCookie, "if-none-match": futureEtag } }
        ),
        { params: { id: String(futureJson.id), photoId: String(upJson.photo.id) } }
      );
      assert(hiddenCached.status === 404, "hidden notice never 304 even with etag");
    }

    section("blob deleted on photo delete and notice delete");
    {
      const store = getCourseReportPhotoStore();
      const rows = await prisma.noticePhoto.findMany({
        where: { noticeId: createdJson.id },
      });
      assert(rows.length === NOTICE_PHOTO_MAX, `${NOTICE_PHOTO_MAX} stored keys`);
      const firstKey = rows[0].storageKey;
      const restKeys = rows.slice(1).map((r) => r.storageKey);
      assert((await store.get(firstKey)) != null, "blob exists before individual delete");

      const delOne = await DELETE_PHOTO(
        req(
          `https://www.verthill.kr/api/notice/${createdJson.id}/photos/${rows[0].id}`,
          { method: "DELETE", headers: { cookie: adminCookie } }
        ),
        { params: { id: String(createdJson.id), photoId: String(rows[0].id) } }
      );
      assert(delOne.status === 200, "individual photo delete 200");
      assert((await store.get(firstKey)) == null, "individual delete removes blob");
      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: createdJson.id } })) ===
          NOTICE_PHOTO_MAX - 1,
        "remaining photos stay after individual delete"
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
      const up = await postPhoto(adminCookie, doomedJson.id, jpegBytes(32, 21));
      const upJson = await up.json();
      const doomedRow = await prisma.noticePhoto.findUnique({
        where: { id: upJson.photo.id },
      });
      const doomedKey = doomedRow?.storageKey ?? "";
      assert((await store.get(doomedKey)) != null, "blob exists before notice delete");
      const gone = await DELETE_NOTICE(
        req(`https://www.verthill.kr/api/notice/${doomedJson.id}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(doomedJson.id) } }
      );
      assert(gone.status === 200, "notice delete 200");
      assert((await store.get(doomedKey)) == null, "notice delete removes blobs");
      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: doomedJson.id } })) === 0,
        "notice delete cascades photo rows"
      );
      assert((await store.get(restKeys[0])) != null, "other notice blobs stay");
    }

    section("upload rollback deletes blob when row create fails");
    {
      const { uploadNoticePhoto } = await import("../src/lib/noticePhoto");
      const inner = getCourseReportPhotoStore();
      let lastPut = "";
      setCourseReportPhotoStoreForTests({
        configured: true,
        async put(key, bytes, mime) {
          lastPut = key;
          return inner.put(key, bytes, mime);
        },
        get: (key) => inner.get(key),
        delete: (key) => inner.delete(key),
      });
      const before = await prisma.noticePhoto.count({ where: { noticeId: createdJson.id } });
      const origCreate = prisma.noticePhoto.create.bind(prisma.noticePhoto);
      const restoreTx = passthroughNoticeTransaction();
      prisma.noticePhoto.create = (async () => {
        throw new Error("forced_create_fail");
      }) as typeof prisma.noticePhoto.create;
      try {
        await uploadNoticePhoto(prisma, {
          noticeId: createdJson.id,
          bytes: jpegBytes(32, 77),
          auth: {
            session: {} as never,
            userId: uAdmin.id,
            username: uAdmin.username,
            role: "admin",
            sessionVersion: 0,
            caddyId: null,
            managedTeams: [],
            mustChangePassword: false,
          },
        });
        assert(false, "create fail should throw");
      } catch (e) {
        assert(e instanceof Error && e.message === "forced_create_fail", "row create failed");
      } finally {
        prisma.noticePhoto.create = origCreate;
        restoreTx();
      }
      assert(lastPut.length > 0, "blob put before row create");
      assert((await inner.get(lastPut)) == null, "failed upload blob rolled back");
      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: createdJson.id } })) === before,
        "failed upload leaves no extra row"
      );
      setCourseReportPhotoStoreForTests(inner);
    }

    section("DB delete first; blob cleanup best-effort");
    {
      const inner = getCourseReportPhotoStore();
      const auth = adminAuth(uAdmin);

      const rowFail = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-row-fail`, content: "keep" }),
        })
      );
      const rowFailJson = await rowFail.json();
      noticeIds.push(rowFailJson.id);
      const rowFailUp = await postPhoto(adminCookie, rowFailJson.id, jpegBytes(32, 31));
      const rowFailPhoto = await rowFailUp.json();
      const rowFailRow = await prisma.noticePhoto.findUnique({
        where: { id: rowFailPhoto.photo.id },
      });
      const rowFailKey = rowFailRow?.storageKey ?? "";
      let photoBlobDeletes = 0;
      setCourseReportPhotoStoreForTests({
        configured: true,
        put: (key, bytes, mime) => inner.put(key, bytes, mime),
        get: (key) => inner.get(key),
        async delete(key) {
          photoBlobDeletes += 1;
          return inner.delete(key);
        },
      });
      const origPhotoDelete = prisma.noticePhoto.delete.bind(prisma.noticePhoto);
      prisma.noticePhoto.delete = (async () => {
        throw new Error("forced_photo_delete_fail");
      }) as typeof prisma.noticePhoto.delete;
      try {
        await deleteNoticePhoto(prisma, {
          noticeId: rowFailJson.id,
          photoId: rowFailPhoto.photo.id,
          auth,
        });
        assert(false, "photo row delete fail should throw");
      } catch (e) {
        assert(
          e instanceof Error && e.message === "forced_photo_delete_fail",
          "photo DB delete failed"
        );
      } finally {
        prisma.noticePhoto.delete = origPhotoDelete;
      }
      assert(photoBlobDeletes === 0, "photo DB delete fail: blob delete 0");
      assert((await inner.get(rowFailKey)) != null, "photo DB delete fail keeps blob");
      assert(
        (await prisma.noticePhoto.findUnique({ where: { id: rowFailPhoto.photo.id } })) != null,
        "photo DB delete fail keeps row"
      );

      const noticeFail = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-notice-fail`, content: "keep" }),
        })
      );
      const noticeFailJson = await noticeFail.json();
      noticeIds.push(noticeFailJson.id);
      const noticeFailUp = await postPhoto(adminCookie, noticeFailJson.id, jpegBytes(32, 32));
      const noticeFailPhoto = await noticeFailUp.json();
      const noticeFailRow = await prisma.noticePhoto.findUnique({
        where: { id: noticeFailPhoto.photo.id },
      });
      const noticeFailKey = noticeFailRow?.storageKey ?? "";
      let noticeBlobDeletes = 0;
      setCourseReportPhotoStoreForTests({
        configured: true,
        put: (key, bytes, mime) => inner.put(key, bytes, mime),
        get: (key) => inner.get(key),
        async delete(key) {
          noticeBlobDeletes += 1;
          return inner.delete(key);
        },
      });
      const origNoticeDelete = prisma.notice.delete.bind(prisma.notice);
      prisma.notice.delete = (async () => {
        throw new Error("forced_notice_delete_fail");
      }) as typeof prisma.notice.delete;
      try {
        await DELETE_NOTICE(
          req(`https://www.verthill.kr/api/notice/${noticeFailJson.id}`, {
            method: "DELETE",
            headers: { cookie: adminCookie },
          }),
          { params: { id: String(noticeFailJson.id) } }
        );
        assert(false, "notice DB delete fail should throw");
      } catch (e) {
        assert(
          e instanceof Error && e.message === "forced_notice_delete_fail",
          "notice DB delete failed"
        );
      } finally {
        prisma.notice.delete = origNoticeDelete;
      }
      assert(noticeBlobDeletes === 0, "notice DB delete fail: blob delete 0");
      assert((await inner.get(noticeFailKey)) != null, "notice DB delete fail keeps blob");
      assert(
        (await prisma.notice.findUnique({ where: { id: noticeFailJson.id } })) != null,
        "notice DB delete fail keeps notice"
      );
      assert(
        (await prisma.noticePhoto.findUnique({ where: { id: noticeFailPhoto.photo.id } })) != null,
        "notice DB delete fail keeps photo row"
      );

      const blobFail = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-blob-fail`, content: "gone-row" }),
        })
      );
      const blobFailJson = await blobFail.json();
      noticeIds.push(blobFailJson.id);
      const blobFailUp = await postPhoto(adminCookie, blobFailJson.id, jpegBytes(32, 33));
      const blobFailPhoto = await blobFailUp.json();
      const blobFailRow = await prisma.noticePhoto.findUnique({
        where: { id: blobFailPhoto.photo.id },
      });
      const blobFailKey = blobFailRow?.storageKey ?? "";
      setCourseReportPhotoStoreForTests({
        configured: true,
        put: (key, bytes, mime) => inner.put(key, bytes, mime),
        get: (key) => inner.get(key),
        async delete() {
          throw new CourseReportPhotoStorageError(
            "storage_delete_failed",
            "forced_blob_delete_fail",
            502
          );
        },
      });
      const photoDel = await deleteNoticePhoto(prisma, {
        noticeId: blobFailJson.id,
        photoId: blobFailPhoto.photo.id,
        auth,
      });
      assert(photoDel.blobCleanupFailed === true, "photo blob cleanup failure reported");
      assert(
        (await prisma.noticePhoto.findUnique({ where: { id: blobFailPhoto.photo.id } })) == null,
        "photo DB delete kept after blob fail"
      );
      assert((await inner.get(blobFailKey)) != null, "failed blob cleanup leaves orphan object");

      const noticeBlobFail = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-notice-blob-fail`, content: "gone" }),
        })
      );
      const noticeBlobFailJson = await noticeBlobFail.json();
      noticeIds.push(noticeBlobFailJson.id);
      const noticeBlobFailUp = await postPhoto(
        adminCookie,
        noticeBlobFailJson.id,
        jpegBytes(32, 34)
      );
      const noticeBlobFailPhoto = await noticeBlobFailUp.json();
      const noticeBlobFailRow = await prisma.noticePhoto.findUnique({
        where: { id: noticeBlobFailPhoto.photo.id },
      });
      const noticeBlobFailKey = noticeBlobFailRow?.storageKey ?? "";
      const gone = await DELETE_NOTICE(
        req(`https://www.verthill.kr/api/notice/${noticeBlobFailJson.id}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(noticeBlobFailJson.id) } }
      );
      const goneJson = await gone.json();
      assert(gone.status === 200, "notice delete 200 when blob cleanup fails");
      assert(goneJson.ok === true, "notice delete ok despite blob cleanup fail");
      assert(goneJson.blobCleanupFailed === true, "notice blob cleanup failure reported");
      assert(
        (await prisma.notice.findUnique({ where: { id: noticeBlobFailJson.id } })) == null,
        "notice DB delete kept after blob fail"
      );
      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: noticeBlobFailJson.id } })) === 0,
        "notice delete still removes photo rows"
      );
      assert((await inner.get(noticeBlobFailKey)) != null, "notice blob orphan remains after fail");
      setCourseReportPhotoStoreForTests(inner);
    }

    section("NoticePhoto table missing: existing notice CRUD stays up");
    {
      const fs = await import("node:fs");
      const path = await import("node:path");
      const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");
      const apiList = read("src/app/api/notice/route.ts");
      const apiOne = read("src/app/api/notice/[id]/route.ts");
      const rscList = read("src/app/notice/page.tsx");
      const rscDetail = read("src/app/notice/[id]/page.tsx");
      const summary = read("src/app/api/summary/route.ts");
      assert(apiList.includes("isNoticePhotoTableMissing"), "GET list falls back if photo table missing");
      assert(apiList.includes("include: { _count: { select: { photos: true } } }"), "GET list counts photos");
      assert(rscList.includes("isNoticePhotoTableMissing"), "RSC list falls back if photo table missing");
      const gallery = read("src/components/notice/NoticePhotoGallery.tsx");
      const css = read("src/app/globals.css");
      const noticePhotoCss = css.slice(
        css.indexOf(".notice-photos {"),
        css.indexOf(".notice-back {")
      );
      assert(gallery.includes("notice-photos-list"), "detail gallery uses uncropped list");
      assert(gallery.includes("notice-photos-item"), "detail gallery item class");
      assert(gallery.includes("notice-photos-lightbox"), "detail lightbox is notice-scoped");
      assert(!gallery.includes("course-report-photo-grid"), "detail does not reuse cropped report grid");
      assert(!gallery.includes("course-report-photo-thumb"), "detail does not reuse cropped report thumb");
      assert(!gallery.includes("course-report-photo-lightbox"), "detail lightbox not report lightbox");
      assert(noticePhotoCss.includes("width: 100%"), "detail photo width 100%");
      assert(/\.notice-photos-item img\s*\{[^}]*object-fit:\s*contain/.test(noticePhotoCss), "detail photo contain");
      assert(/\.notice-photos-item img\s*\{[^}]*height:\s*auto/.test(noticePhotoCss), "detail photo height auto");
      assert(!/\.notice-photos-item\s*\{[^}]*aspect-ratio:/.test(noticePhotoCss), "detail has no fake 4/3 box");
      assert(!/\.notice-photos-item img\s*\{[^}]*object-fit:\s*cover/.test(noticePhotoCss), "item img is not cover");
      assert(
        !noticePhotoCss.includes("object-fit: cover"),
        "detail photo CSS does not crop with cover"
      );
      assert(
        css.includes(".course-report-photo-thumb") &&
          css.includes("object-fit: cover"),
        "course-report thumbs still crop/cover"
      );
      const lightboxCss = noticePhotoCss.slice(noticePhotoCss.indexOf(".notice-photos-lightbox img"));
      assert(lightboxCss.includes("object-fit: contain"), "lightbox contain");
      assert(noticePhotoCss.includes("max-height: 90vh"), "lightbox stage fits viewport");
      assert(lightboxCss.includes("height: auto"), "lightbox keeps ratio");
      assert(!/include:\s*\{\s*photos:/.test(apiOne), "GET detail does not include photos on Notice");
      assert(!/include:\s*\{\s*photos:/.test(rscDetail), "RSC detail does not include photos on Notice");
      assert(!summary.includes("photos:"), "summary notice query has no photos include");
      assert(isNoticePhotoTableMissing(noticePhotoTableMissingError()), "P2021 NoticePhoto detected");
      assert(
        isNoticePhotoTableMissing(new Error('relation "NoticePhoto" does not exist')),
        "pg missing relation detected"
      );
      assert(
        !isNoticePhotoTableMissing(new Error("connection refused")),
        "unrelated errors are not table-missing"
      );

      const snapshot = await prisma.notice.findUnique({ where: { id: createdJson.id } });
      const photoCountBefore = await prisma.noticePhoto.count({
        where: { noticeId: createdJson.id },
      });
      assert(snapshot != null, "fixture notice exists before missing-table mock");

      const origNoticeFindMany = prisma.notice.findMany.bind(prisma.notice);
      const origPhotoFindMany = prisma.noticePhoto.findMany.bind(prisma.noticePhoto);
      const origPhotoFindUnique = prisma.noticePhoto.findUnique.bind(prisma.noticePhoto);
      const origPhotoCount = prisma.noticePhoto.count.bind(prisma.noticePhoto);
      const origPhotoCreate = prisma.noticePhoto.create.bind(prisma.noticePhoto);
      const origPhotoDelete = prisma.noticePhoto.delete.bind(prisma.noticePhoto);
      const restoreTx = passthroughNoticeTransaction();
      const boom = async () => {
        throw noticePhotoTableMissingError();
      };
      prisma.notice.findMany = (async (args?: unknown) => {
        const rec = args as {
          include?: { _count?: { select?: { photos?: boolean } } };
          select?: { _count?: { select?: { photos?: boolean } } };
        };
        if (rec?.include?._count?.select?.photos || rec?.select?._count?.select?.photos) {
          throw noticePhotoTableMissingError();
        }
        return origNoticeFindMany(args as never);
      }) as typeof prisma.notice.findMany;
      prisma.noticePhoto.findMany = boom as typeof prisma.noticePhoto.findMany;
      prisma.noticePhoto.findUnique = boom as typeof prisma.noticePhoto.findUnique;
      prisma.noticePhoto.count = boom as typeof prisma.noticePhoto.count;
      prisma.noticePhoto.create = boom as typeof prisma.noticePhoto.create;
      prisma.noticePhoto.delete = boom as typeof prisma.noticePhoto.delete;

      try {
        const list = await GET_NOTICE_LIST(
          req("https://www.verthill.kr/api/notice", {
            headers: { cookie: adminCookie },
          })
        );
        const listBody = (await list.json()) as Array<{ id: number; photoCount?: number }>;
        assert(list.status === 200, "list 200 when NoticePhoto table missing");
        const listed = listBody.find((row) => row.id === createdJson.id);
        assert(listed != null, "existing notice still listed");
        assert(listed?.photoCount === 0, "list photoCount 0 without table");

        const detail = await GET_NOTICE(
          req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
            headers: { cookie: adminCookie },
          }),
          { params: { id: String(createdJson.id) } }
        );
        const detailBody = await detail.json();
        assert(detail.status === 200, "detail 200 when NoticePhoto table missing");
        assert(detailBody.id === createdJson.id, "detail returns existing notice");
        assert(Array.isArray(detailBody.photos) && detailBody.photos.length === 0, "detail photos []");
        assert(detailBody.photoCount === 0, "detail photoCount 0");

        const created = await POST_NOTICE(
          req("https://www.verthill.kr/api/notice", {
            method: "POST",
            headers: { cookie: adminCookie, "content-type": "application/json" },
            body: JSON.stringify({ title: `${tag}-no-table-create`, content: "text only" }),
          })
        );
        const createdMissing = await created.json();
        noticeIds.push(createdMissing.id);
        assert(created.status === 200 && typeof createdMissing.id === "number", "text create ok");

        const patched = await PATCH_NOTICE(
          req(`https://www.verthill.kr/api/notice/${createdMissing.id}`, {
            method: "PATCH",
            headers: { cookie: adminCookie, "content-type": "application/json" },
            body: JSON.stringify({ title: `${tag}-no-table-patched` }),
          }),
          { params: { id: String(createdMissing.id) } }
        );
        assert(patched.status === 200, "text patch ok without photo table");

        const up = await postPhoto(adminCookie, createdMissing.id, jpegBytes(32, 41));
        const upJson = await up.json();
        assert(up.status === 503, "photo upload 503 without table");
        assert(upJson.error === "photo_table_not_ready", "upload table-not-ready");

        const got = await GET_PHOTO(
          req(`https://www.verthill.kr/api/notice/${createdJson.id}/photos/1`, {
            headers: { cookie: adminCookie },
          }),
          { params: { id: String(createdJson.id), photoId: "1" } }
        );
        const gotJson = await got.json();
        assert(got.status === 503, "photo GET 503 without table");
        assert(gotJson.error === "photo_table_not_ready", "read table-not-ready");

        const delPhoto = await DELETE_PHOTO(
          req(`https://www.verthill.kr/api/notice/${createdJson.id}/photos/1`, {
            method: "DELETE",
            headers: { cookie: adminCookie },
          }),
          { params: { id: String(createdJson.id), photoId: "1" } }
        );
        const delPhotoJson = await delPhoto.json();
        assert(delPhoto.status === 503, "photo DELETE 503 without table");
        assert(delPhotoJson.error === "photo_table_not_ready", "delete table-not-ready");

        const doomed = await POST_NOTICE(
          req("https://www.verthill.kr/api/notice", {
            method: "POST",
            headers: { cookie: adminCookie, "content-type": "application/json" },
            body: JSON.stringify({ title: `${tag}-no-table-del`, content: "gone" }),
          })
        );
        const doomedJson = await doomed.json();
        noticeIds.push(doomedJson.id);
        const gone = await DELETE_NOTICE(
          req(`https://www.verthill.kr/api/notice/${doomedJson.id}`, {
            method: "DELETE",
            headers: { cookie: adminCookie },
          }),
          { params: { id: String(doomedJson.id) } }
        );
        assert(gone.status === 200, "text notice delete ok without photo table");
        assert(
          (await prisma.notice.findUnique({ where: { id: doomedJson.id } })) == null,
          "deleted notice stays deleted"
        );

        const after = await prisma.notice.findUnique({ where: { id: createdJson.id } });
        assert(after?.title === snapshot?.title, "existing notice title unchanged");
        assert(after?.content === snapshot?.content, "existing notice content unchanged");
      } finally {
        prisma.notice.findMany = origNoticeFindMany;
        prisma.noticePhoto.findMany = origPhotoFindMany;
        prisma.noticePhoto.findUnique = origPhotoFindUnique;
        prisma.noticePhoto.count = origPhotoCount;
        prisma.noticePhoto.create = origPhotoCreate;
        prisma.noticePhoto.delete = origPhotoDelete;
        restoreTx();
      }

      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: createdJson.id } })) === photoCountBefore,
        "existing photo rows not damaged"
      );
    }

    section("parallel upload lock, order, limit");
    {
      const createdPar = await POST_NOTICE(
        req("https://www.verthill.kr/api/notice", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-parallel`, content: "par" }),
        })
      );
      const parJson = await createdPar.json();
      noticeIds.push(parJson.id);
      const putDelay = 80;
      setCourseReportPhotoStoreForTests({
        ...mem,
        async put(key, bytes, mime) {
          await new Promise((r) => setTimeout(r, putDelay));
          return mem.put(key, bytes, mime);
        },
      });
      const seqStart = Date.now();
      for (let i = 0; i < 3; i++) {
        const res = await postPhoto(adminCookie, parJson.id, jpegBytes(24, 40 + i));
        assert(res.status === 200, `sequential photo ${i + 1} ok`);
      }
      const sequentialMs = Date.now() - seqStart;

      const parStart = Date.now();
      const parRes = await Promise.all(
        [0, 1, 2, 3, 4, 5].map((i) => {
          const form = new FormData();
          form.append("file", new Blob([jpegBytes(24, 50 + i)], { type: "image/jpeg" }), "n.jpg");
          form.append("sortOrder", String(10 + i));
          return POST_PHOTO(
            req(`https://www.verthill.kr/api/notice/${parJson.id}/photos`, {
              method: "POST",
              headers: { cookie: adminCookie },
              body: form,
            }),
            { params: { id: String(parJson.id) } }
          );
        })
      );
      const parallelMs = Date.now() - parStart;
      assert(
        parRes.every((res) => res.status === 200),
        "6 parallel photo uploads 200"
      );
      const rows = await prisma.noticePhoto.findMany({
        where: { noticeId: parJson.id },
        orderBy: { sortOrder: "asc" },
      });
      assert(rows.length === 9, "3 sequential + 6 parallel stored");
      assert(
        rows.slice(3).map((row) => row.sortOrder).join(",") === "10,11,12,13,14,15",
        "parallel uploads keep requested order"
      );
      assert(parallelMs < sequentialMs * 1.1, "6 parallel blob puts beat 3 sequential wall time");
      console.log(
        `  measured blob+db: sequential 3 photos ${sequentialMs}ms; parallel 6 photos ${parallelMs}ms (put delay ${putDelay}ms)`
      );

      const extras = await Promise.all(
        [0, 1, 2, 3].map((i) => postPhoto(adminCookie, parJson.id, jpegBytes(16, 80 + i)))
      );
      const extraOk = extras.filter((res) => res.status === 200).length;
      const extraConflict = extras.filter((res) => res.status === 409).length;
      assert(extraOk + extraConflict === 4, "over-limit parallel all answered");
      assert(extraOk === 1 && extraConflict === 3, "lock allows only the remaining slot");
      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: parJson.id } })) === NOTICE_PHOTO_MAX,
        "parallel over-limit does not exceed max 10"
      );
      setCourseReportPhotoStoreForTests(mem);
    }

    section("patch without sendPush keeps photos");
    {
      const patch = await PATCH_NOTICE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}-plain-edited` }),
        }),
        { params: { id: String(createdJson.id) } }
      );
      assert(patch.status === 200, "patch ok");
      const after = await GET_NOTICE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(createdJson.id) } }
      );
      const body = await after.json();
      assert(body.photos.length === NOTICE_PHOTO_MAX - 1, "remaining photos survive text patch");
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
