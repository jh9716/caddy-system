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
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "notice-photo-unit-secret-32chars!!!";
  setCourseReportPhotoStoreForTests(createMemoryCourseReportPhotoStore());

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
      await postPhoto(adminCookie, createdJson.id, jpegBytes(32, 2));
      const third = await postPhoto(adminCookie, createdJson.id, jpegBytes(32, 3));
      assert(third.status === 200, "third photo ok");
      const fourth = await postPhoto(adminCookie, createdJson.id, jpegBytes(32, 4));
      assert(fourth.status === 409, `over ${NOTICE_PHOTO_MAX} rejected`);
      const detail = await GET_NOTICE(
        req(`https://www.verthill.kr/api/notice/${createdJson.id}`, {
          headers: { cookie: adminCookie },
        }),
        { params: { id: String(createdJson.id) } }
      );
      const body = await detail.json();
      assert(body.photos.length === 3, "three photos listed");
      assert(body.photoCount === 3, "photoCount 3");
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
    }

    section("blob deleted on photo delete and notice delete");
    {
      const store = getCourseReportPhotoStore();
      const rows = await prisma.noticePhoto.findMany({
        where: { noticeId: createdJson.id },
      });
      assert(rows.length === 3, "three stored keys");
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
        (await prisma.noticePhoto.count({ where: { noticeId: createdJson.id } })) === 2,
        "two photos remain after individual delete"
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
      assert(noticePhotoCss.includes("height: auto"), "detail photo height auto");
      assert(noticePhotoCss.includes("object-fit: contain"), "detail photo contain");
      assert(!/\baspect-ratio\b/.test(noticePhotoCss), "detail photo CSS has no aspect-ratio");
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
      assert(lightboxCss.includes("max-height: 90vh"), "lightbox fits viewport");
      assert(lightboxCss.includes("width: auto") && lightboxCss.includes("height: auto"), "lightbox keeps ratio");
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
      }

      assert(
        (await prisma.noticePhoto.count({ where: { noticeId: createdJson.id } })) === photoCountBefore,
        "existing photo rows not damaged"
      );
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
      assert(body.photos.length === 2, "remaining photos survive text patch");
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
