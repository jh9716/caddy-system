/**
 * 자유게시판 V1 — local caddy_local only (assertLocalDatabaseUrl).
 * 실행: npm run test:free-board-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { SESSION_COOKIE_NAME, buildSessionClaims, signSessionClaims } from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import {
  createMemoryCourseReportPhotoStore,
  type CourseReportPhotoStore,
} from "../src/lib/courseReportPhotoStorage";
import {
  resolveFreeBoardStorageDecision,
  setFreeBoardStoreFactoryForTests,
} from "../src/lib/freeBoardPhotoStorage";

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
function section(t: string) {
  console.log("\n==", t, "==");
}
const read = (rel: string) => fs.readFileSync(path.resolve(rel), "utf8");
const png = () => Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 1, 2, 3]);

async function cookieFor(u: { id: number | null; username: string; role: "admin" | "caddy" | "leader" }) {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({ userId: u.id, username: u.username, role: u.role, sessionVersion: 0 })
  )}`;
}
const req = (url: string, init?: ConstructorParameters<typeof NextRequest>[1]) =>
  new NextRequest(url, init);
const json = (r: Response) => r.json().catch(() => ({}));
const idP = (id: number) => ({ params: { id: String(id) } });

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevFlag = process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  process.env.SESSION_SECRET = "free-board-unit-secret-32chars!!!!";

  section("flag OFF (기본값) — Production 비노출");
  delete process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
  const { isFreeBoardEnabled } = await import("../src/lib/freeBoardConstants");
  const { memberNavItems } = await import("../src/lib/boardNav");
  assert(isFreeBoardEnabled() === false, "flag default off");
  assert(!memberNavItems().some((i) => i.href === "/community"), "member nav hides /community when off");
  const { ADMIN_MAIN_NAV } = await import("../src/lib/adminManageNav");
  assert(!ADMIN_MAIN_NAV.some((i) => i.href === "/community"), "admin nav hides /community when off");
  {
    const layout = read("src/app/community/layout.tsx");
    assert(/if \(!isFreeBoardEnabled\(\)\) notFound\(\)/.test(layout), "layout: flag OFF → notFound");
    const access = read("src/lib/freeBoard.ts");
    assert(/if \(!isFreeBoardEnabled\(\)\) return freeBoardDisabledResponse\(\)/.test(access), "API guard: flag OFF → 404 before auth");
    for (const f of [
      "src/app/api/free-board/route.ts",
      "src/app/api/free-board/[id]/route.ts",
      "src/app/api/free-board/[id]/photos/route.ts",
      "src/app/api/free-board/[id]/photos/[photoId]/route.ts",
      "src/app/api/free-board/[id]/comments/route.ts",
      "src/app/api/free-board/[id]/comments/[commentId]/route.ts",
    ]) {
      const src = read(f);
      const handlers = (src.match(/export async function (GET|POST|PATCH|DELETE)/g) || []).length;
      const guards = (src.match(/requireFreeBoardReader\(req\)/g) || []).length;
      assert(handlers > 0 && handlers === guards, `${f}: 모든 handler 가 flag/auth guard 사용`);
    }
  }
  const listMod = await import("../src/app/api/free-board/route");
  const off = await listMod.GET(req("http://local/api/free-board"));
  assert(off.status === 404, "API 404 when flag off");

  section("source safety");
  {
    const files = [
      "src/lib/freeBoard.ts",
      "src/lib/freeBoardPhoto.ts",
      "src/lib/freeBoardComments.ts",
      "src/app/community/FreeBoardForm.tsx",
      "src/app/community/[id]/FreeBoardComments.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("dangerouslySetInnerHTML"), `${rel} no innerHTML`);
      assert(!/chat/i.test(src.replace(/chatgpt/gi, "")), `${rel} no chat dependency`);
    }
    assert(!fs.existsSync("src/app/board/community"), "/board 경로 미사용");
    const mig = read("prisma/migrations/20261031220000_free_board_v1/migration.sql");
    assert(!/DROP|ALTER TABLE "(?!FreeBoard)/.test(mig.replace(/ALTER TABLE "FreeBoard\w*"/g, "")), "migration additive only");
    assert(read("src/lib/freeBoardPhoto.ts").includes("FREE_BOARD_STORAGE_PREFIX"), "dedicated storage prefix");
  }

  process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = "1";
  assert(isFreeBoardEnabled() === true, "flag on");
  assert(memberNavItems().some((i) => i.href === "/community"), "member nav shows /community when on");

  const { GET: LIST, POST: CREATE } = listMod;
  const { GET: DETAIL, PATCH, DELETE: DEL } = await import("../src/app/api/free-board/[id]/route");
  const { POST: PHOTO_POST } = await import("../src/app/api/free-board/[id]/photos/route");
  const { GET: PHOTO_GET, DELETE: PHOTO_DEL } = await import(
    "../src/app/api/free-board/[id]/photos/[photoId]/route"
  );
  const { GET: C_LIST, POST: C_POST } = await import("../src/app/api/free-board/[id]/comments/route");
  const { DELETE: C_DEL } = await import("../src/app/api/free-board/[id]/comments/[commentId]/route");
  const { buildFreeBoardPhotoStorageKey, isFreeBoardStorageKey } = await import("../src/lib/freeBoardPhoto");

  const tag = `fb_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const postIds: number[] = [];
  // 실제 Blob 호출 없음: 정책 판정은 실제 코드, store 만 메모리 mock.
  const mem = createMemoryCourseReportPhotoStore();
  const sharedMem = createMemoryCourseReportPhotoStore();
  let sharedCalls = 0;
  let deleteCalls = 0;
  let failDeleteKeys = new Set<string>();
  const dedicated: CourseReportPhotoStore = {
    ...mem,
    async delete(key) {
      deleteCalls++;
      if (failDeleteKeys.has(key)) throw new Error("mock delete failure");
      return mem.delete(key);
    },
  };
  const sharedSpy: CourseReportPhotoStore = {
    ...sharedMem,
    async put(...a) {
      sharedCalls++;
      return sharedMem.put(...a);
    },
    async delete(k) {
      sharedCalls++;
      return sharedMem.delete(k);
    },
  };
  setFreeBoardStoreFactoryForTests({ dedicated: () => dedicated, shared: () => sharedSpy });
  const prevEnv = {
    VERCEL_ENV: process.env.VERCEL_ENV,
    FREE_BOARD_STORAGE_ENV: process.env.FREE_BOARD_STORAGE_ENV,
    FREE_BOARD_BLOB_READ_WRITE_TOKEN: process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN,
    BLOB_READ_WRITE_TOKEN: process.env.BLOB_READ_WRITE_TOKEN,
    BLOB_STORE_ID: process.env.BLOB_STORE_ID,
  };
  // 가짜 값 (실제 토큰 아님)
  const FAKE_PREVIEW = "vercel_blob_rw_previewstore111_fakesecret";
  const FAKE_PROD = "vercel_blob_rw_prodstore999_fakesecret";
  Object.assign(process.env, {
    VERCEL_ENV: "preview",
    FREE_BOARD_STORAGE_ENV: "preview",
    FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW,
    BLOB_READ_WRITE_TOKEN: FAKE_PROD,
  });
  delete process.env.BLOB_STORE_ID;

  section("storage isolation policy");
  {
    const D = (env: Record<string, string>) => resolveFreeBoardStorageDecision(env);
    const ok = D({ VERCEL_ENV: "preview", FREE_BOARD_STORAGE_ENV: "preview", FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW, BLOB_READ_WRITE_TOKEN: FAKE_PROD });
    assert(ok.ok && ok.mode === "dedicated", "preview + 전용 토큰 + 마커 → dedicated");
    const noTok = D({ VERCEL_ENV: "preview", FREE_BOARD_STORAGE_ENV: "preview", BLOB_READ_WRITE_TOKEN: FAKE_PROD });
    assert(!noTok.ok && noTok.code === "free_board_preview_storage_missing", "preview 전용 토큰 없음 → 차단 (공용 fallback 없음)");
    const noMarker = D({ VERCEL_ENV: "preview", FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW });
    assert(!noMarker.ok && noMarker.code === "free_board_preview_storage_missing", "마커 없음 → 차단");
    const same = D({ VERCEL_ENV: "preview", FREE_BOARD_STORAGE_ENV: "preview", FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PROD, BLOB_READ_WRITE_TOKEN: FAKE_PROD });
    assert(!same.ok && same.code === "free_board_storage_shared", "공용 토큰과 동일 → 차단");
    const sameStore = D({ VERCEL_ENV: "preview", FREE_BOARD_STORAGE_ENV: "preview", FREE_BOARD_BLOB_READ_WRITE_TOKEN: "vercel_blob_rw_prodstore999_other", BLOB_READ_WRITE_TOKEN: FAKE_PROD });
    assert(!sameStore.ok && sameStore.code === "free_board_storage_shared", "같은 store id (다른 토큰) → 차단");
    const sameStoreId = D({ VERCEL_ENV: "preview", FREE_BOARD_STORAGE_ENV: "preview", FREE_BOARD_BLOB_READ_WRITE_TOKEN: FAKE_PREVIEW, BLOB_STORE_ID: "store_previewstore111" });
    assert(!sameStoreId.ok && sameStoreId.code === "free_board_storage_shared", "BLOB_STORE_ID 와 같은 store → 차단");
    const badFmt = D({ VERCEL_ENV: "preview", FREE_BOARD_STORAGE_ENV: "preview", FREE_BOARD_BLOB_READ_WRITE_TOKEN: "garbage" });
    assert(!badFmt.ok && badFmt.code === "free_board_storage_token_invalid", "토큰 형식 불명 → 차단");
    const local = D({});
    assert(!local.ok, "로컬/미설정 → 차단");
    const prod = D({ VERCEL_ENV: "production" });
    assert(prod.ok && prod.mode === "shared", "production → 기존 공용 store (free-board/ prefix)");
    const prodMarker = D({ VERCEL_ENV: "production", FREE_BOARD_STORAGE_ENV: "preview" });
    assert(!prodMarker.ok && prodMarker.code === "free_board_storage_env_mismatch", "production 에 preview 마커 → 차단");
    const msgs = [noTok, same, sameStore, badFmt].map((d) => JSON.stringify(d)).join(" ");
    assert(!msgs.includes("fakesecret") && !msgs.includes("prodstore999"), "판정 결과에 토큰/스토어 값 미포함");
  }
  try {
    const cA = await prisma.caddy.create({
      data: { name: "자유캐디A", team: "1조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    const cB = await prisma.caddy.create({
      data: { name: "자유캐디B", team: "2조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
    });
    caddyIds.push(cA.id, cB.id);
    const uA = await prisma.user.create({
      data: { username: `${tag}_a`, password: hash, role: "caddy", caddyId: cA.id },
    });
    const uB = await prisma.user.create({
      data: { username: `${tag}_b`, password: hash, role: "caddy", caddyId: cB.id },
    });
    const uAdmin = await prisma.user.create({
      data: { username: `${tag}_admin`, password: hash, role: "admin" },
    });
    userIds.push(uA.id, uB.id, uAdmin.id);
    const A = await cookieFor({ id: uA.id, username: uA.username, role: "caddy" });
    const B = await cookieFor({ id: uB.id, username: uB.username, role: "caddy" });
    const ADM = await cookieFor({ id: uAdmin.id, username: uAdmin.username, role: "admin" });
    const H = (cookie: string) => ({ cookie, "content-type": "application/json" });

    section("auth");
    assert((await LIST(req("http://local/api/free-board"))).status === 401, "unauth list 401");
    assert(
      (
        await CREATE(
          req("http://local/api/free-board", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: "t", body: "b" }),
          })
        )
      ).status === 401,
      "unauth create 401"
    );

    section("create / validation");
    const bad1 = await CREATE(
      req("http://local/api/free-board", { method: "POST", headers: H(A), body: JSON.stringify({ title: " ", body: "b" }) })
    );
    assert(bad1.status === 400, "empty title 400");
    const bad2 = await CREATE(
      req("http://local/api/free-board", {
        method: "POST",
        headers: H(A),
        body: JSON.stringify({ title: "x".repeat(101), body: "b" }),
      })
    );
    assert(bad2.status === 400, "title too long 400");
    const bad3 = await CREATE(
      req("http://local/api/free-board", {
        method: "POST",
        headers: H(A),
        body: JSON.stringify({ title: "t", body: "b".repeat(5001) }),
      })
    );
    assert(bad3.status === 400, "body too long 400");
    const created = await CREATE(
      req("http://local/api/free-board", {
        method: "POST",
        headers: H(A),
        body: JSON.stringify({ title: " 첫 글 ", body: "<b>내용</b>" }),
      })
    );
    const cBody = await json(created);
    assert(created.status === 201, "create 201");
    const pid = Number(cBody.id);
    postIds.push(pid);
    assert(cBody.post.title === "첫 글", "title trimmed");
    assert(cBody.post.body === "<b>내용</b>", "body stored as plain text");
    assert(cBody.post.authorDisplayName === "자유캐디A", "author display = caddy name");
    assert(cBody.post.canEdit && cBody.post.canDelete, "author can edit/delete");

    section("list / detail");
    const list = await json(await LIST(req("http://local/api/free-board", { headers: { cookie: B } })));
    const row = list.posts.find((p: { id: number }) => p.id === pid);
    assert(row && row.canEdit === false && row.canDelete === false, "other: no edit/delete flags");
    assert(list.canCompose === true, "caddy canCompose");
    const adminList = await json(await LIST(req("http://local/api/free-board", { headers: { cookie: ADM } })));
    const arow = adminList.posts.find((p: { id: number }) => p.id === pid);
    assert(arow.canDelete === true && arow.canEdit === false, "admin: delete yes, edit no");
    const det = await DETAIL(req(`http://local/api/free-board/${pid}`, { headers: { cookie: B } }), idP(pid));
    assert(det.status === 200, "detail 200");
    assert((await DETAIL(req(`http://local/api/free-board/999999`, { headers: { cookie: B } }), idP(999999))).status === 404, "missing 404");
    assert((await DETAIL(req(`http://local/api/free-board/abc`, { headers: { cookie: B } }), { params: { id: "abc" } })).status === 404, "bad id 404");

    section("edit (author only)");
    const patch = (cookie: string, body: unknown) =>
      PATCH(req(`http://local/api/free-board/${pid}`, { method: "PATCH", headers: H(cookie), body: JSON.stringify(body) }), idP(pid));
    assert((await patch(B, { title: "x", body: "y" })).status === 403, "other PATCH 403");
    assert((await patch(ADM, { title: "x", body: "y" })).status === 403, "admin PATCH others 403");
    assert((await patch(A, { title: "", body: "y" })).status === 400, "author PATCH invalid 400");
    const ok = await patch(A, { title: "수정 제목", body: "수정 내용" });
    assert(ok.status === 200, "author PATCH 200");
    const after = await prisma.freeBoardPost.findUnique({ where: { id: pid } });
    assert(after?.title === "수정 제목" && after?.authorUserId === uA.id, "DB updated, author unchanged");

    section("photos (max 9, type, permission, prefix)");
    const up = (cookie: string, bytes: Uint8Array, id = pid) => {
      const fd = new FormData();
      fd.append("file", new Blob([bytes], { type: "image/png" }), "p.png");
      return PHOTO_POST(req(`http://local/api/free-board/${id}/photos`, { method: "POST", headers: { cookie }, body: fd }), idP(id));
    };
    assert((await up(B, png())).status === 403, "other upload 403");
    assert((await up(ADM, png())).status === 403, "admin upload to others 403");
    const notImg = await up(A, Uint8Array.from([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]));
    assert(notImg.status >= 400 && notImg.status < 500, "non-image rejected 4xx");
    let lastPhotoId = 0;
    for (let i = 0; i < 9; i++) {
      const r = await up(A, png());
      const b = await json(r);
      if (r.status !== 201) console.error("upload", i, r.status, b);
      lastPhotoId = Number(b.photo?.id);
    }
    assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === 9, "9 photos stored");
    const tenth = await up(A, png());
    assert(tenth.status === 409, "10th photo 409");
    assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === 9, "still 9 after 10th");
    const keys = await prisma.freeBoardPhoto.findMany({ where: { postId: pid }, select: { storageKey: true } });
    assert(keys.every((k) => k.storageKey.startsWith(`free-board/${pid}/`)), "all keys under free-board/<postId>/");
    assert(isFreeBoardStorageKey(buildFreeBoardPhotoStorageKey(1, "image/png")), "key builder prefix");
    assert(!isFreeBoardStorageKey("notices/1/x.png"), "notice key rejected");
    assert(!isFreeBoardStorageKey("free-board/../notices/x.png"), "traversal rejected");
    const pget = await PHOTO_GET(
      req(`http://local/api/free-board/${pid}/photos/${lastPhotoId}`, { headers: { cookie: B } }),
      { params: { id: String(pid), photoId: String(lastPhotoId) } }
    );
    assert(pget.status === 200, "photo GET 200 for reader");
    const pdelOther = await PHOTO_DEL(
      req(`http://local/api/free-board/${pid}/photos/${lastPhotoId}`, { method: "DELETE", headers: { cookie: B } }),
      { params: { id: String(pid), photoId: String(lastPhotoId) } }
    );
    assert(pdelOther.status === 403, "other photo delete 403");
    const pdel = await PHOTO_DEL(
      req(`http://local/api/free-board/${pid}/photos/${lastPhotoId}`, { method: "DELETE", headers: { cookie: A } }),
      { params: { id: String(pid), photoId: String(lastPhotoId) } }
    );
    assert(pdel.status === 200, "author photo delete 200");
    assert((await up(A, png())).status === 201, "upload again after delete (8→9)");
    assert(sharedCalls === 0, "preview 에서 공용 store 미사용");

    section("comments");
    const cpost = (cookie: string, body: unknown) =>
      C_POST(req(`http://local/api/free-board/${pid}/comments`, { method: "POST", headers: H(cookie), body: JSON.stringify({ body }) }), idP(pid));
    const c1 = await cpost(B, "B 댓글");
    assert(c1.status === 201, "comment create 201");
    const c1id = Number((await json(c1)).comment.id);
    assert((await cpost(B, "  ")).status === 400, "empty comment 400");
    const cl = await json(await C_LIST(req(`http://local/api/free-board/${pid}/comments`, { headers: { cookie: A } }), idP(pid)));
    assert(cl.comments.length === 1 && cl.comments[0].authorDisplayName === "자유캐디B", "comment list with author");
    assert(
      (await json(await LIST(req("http://local/api/free-board", { headers: { cookie: A } })))).posts.find(
        (p: { id: number }) => p.id === pid
      ).commentCount === 1,
      "list commentCount 1"
    );
    const cdel = (cookie: string, cid: number) =>
      C_DEL(req(`http://local/api/free-board/${pid}/comments/${cid}`, { method: "DELETE", headers: { cookie } }), {
        params: { id: String(pid), commentId: String(cid) },
      });
    assert((await cdel(A, c1id)).status === 403, "non-author comment delete 403");
    const c2id = Number((await json(await cpost(A, "A 댓글"))).comment.id);
    assert((await cdel(ADM, c1id)).status === 200, "admin comment delete 200");
    assert((await cdel(A, c2id)).status === 200, "own comment delete 200");
    const thread = await prisma.commentThread.findFirst({ where: { targetType: "FREE_BOARD_POST", targetKey: String(pid) } });
    assert(thread != null, "FREE_BOARD_POST thread");

    section("upload blocked when preview storage missing");
    {
      const saved = process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN;
      delete process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN;
      const r = await up(A, png());
      const b = await json(r);
      assert(r.status === 503 && b.error === "free_board_preview_storage_missing", "전용 저장소 없음 → 503 code");
      process.env.FREE_BOARD_BLOB_READ_WRITE_TOKEN = saved;
      assert(sharedCalls === 0, "공용 store 호출 0회 (preview)");
    }

    section("concurrent uploads (race-safe 9 limit)");
    {
      const p2 = await json(
        await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(A), body: JSON.stringify({ title: "동시", body: "b" }) }))
      );
      const id2 = Number(p2.id);
      postIds.push(id2);
      const results = await Promise.all(Array.from({ length: 15 }, () => up(A, png(), id2)));
      const okN = results.filter((r) => r.status === 201).length;
      const limitN = results.filter((r) => r.status === 409).length;
      assert(okN === 9, `동시 15건 중 성공 9 (실제 ${okN})`);
      assert(limitN === 6, `나머지 6건 409 (실제 ${limitN})`);
      assert((await prisma.freeBoardPhoto.count({ where: { postId: id2 } })) === 9, "DB 9장");
      const keys2 = await prisma.freeBoardPhoto.findMany({ where: { postId: id2 }, select: { storageKey: true } });
      let stored = 0;
      for (const k of keys2) if (await mem.head(k.storageKey)) stored++;
      assert(stored === 9, "DB 행마다 객체 존재");
    }

    section("edit with removedPhotoIds (deferred delete)");
    {
      const before = await prisma.freeBoardPhoto.findMany({ where: { postId: pid }, orderBy: { id: "asc" } });
      const [r1, r2] = before;
      // 다른 글 사진 포함 → 전체 거부, 아무것도 바뀌지 않음
      const otherPhoto = await prisma.freeBoardPhoto.findFirst({ where: { postId: { not: pid } } });
      const delBefore = deleteCalls;
      const bad = await patch(A, { title: "t2", body: "b2", removedPhotoIds: [r1.id, otherPhoto!.id] });
      assert(bad.status === 404, "타 게시글 사진 포함 → 404");
      assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === before.length, "거부 시 사진 그대로");
      assert((await prisma.freeBoardPost.findUnique({ where: { id: pid } }))?.title === "수정 제목", "거부 시 본문 그대로");
      assert(deleteCalls === delBefore, "거부 시 객체 삭제 없음");
      assert((await patch(A, { title: "t", body: "b", removedPhotoIds: "x" })).status === 400, "removedPhotoIds 형식 오류 400");
      assert((await patch(B, { title: "t", body: "b", removedPhotoIds: [r1.id] })).status === 403, "타인 removedPhotoIds 403");
      // 부분 성공: r2 객체 삭제 실패 → 응답 성공, DB 일관, orphan 기록
      const { setFreeBoardOrphanLoggerForTests } = await import("../src/lib/freeBoardPhoto");
      const orphans: unknown[] = [];
      setFreeBoardOrphanLoggerForTests((i) => orphans.push(i));
      failDeleteKeys = new Set([r2.storageKey]);
      const ok2 = await patch(A, { title: "사진 정리", body: "본문", removedPhotoIds: [r1.id, r2.id] });
      const okBody = await json(ok2);
      assert(ok2.status === 200, "부분 성공도 200");
      assert(okBody.removedPhotos === 2 && okBody.blobCleanupFailed === 1, "removed 2, blobCleanupFailed 1");
      assert((await prisma.freeBoardPhoto.count({ where: { id: { in: [r1.id, r2.id] } } })) === 0, "DB 행 삭제됨");
      assert(!(await mem.head(r1.storageKey)), "성공 객체 삭제됨");
      assert(Boolean(await mem.head(r2.storageKey)), "실패 객체는 남음 (orphan)");
      assert(orphans.length === 1 && JSON.stringify(orphans).includes(String(r2.id)), "orphan 1건 기록 (photoId)");
      assert(!JSON.stringify(orphans).includes(r2.storageKey), "orphan 로그에 storage key 미포함");
      setFreeBoardOrphanLoggerForTests(null);
      failDeleteKeys = new Set();
      // DB 실패 → 롤백, 객체 삭제 없음
      const { saveFreeBoardPostEdit } = await import("../src/lib/freeBoardPhoto");
      const r3 = (await prisma.freeBoardPhoto.findFirst({ where: { postId: pid } }))!;
      const failingDb = new Proxy(prisma, {
        get(t, k) {
          if (k === "$transaction") return async () => { throw new Error("db down"); };
          return Reflect.get(t, k);
        },
      }) as typeof prisma;
      const delBefore2 = deleteCalls;
      let threw = false;
      try {
        await saveFreeBoardPostEdit(failingDb, { postId: pid, title: "x", body: "y", removedPhotoIds: [r3.id] });
      } catch {
        threw = true;
      }
      assert(threw, "DB 실패 → 예외");
      assert(deleteCalls === delBefore2, "DB 실패 시 객체 삭제 호출 0");
      assert(Boolean(await prisma.freeBoardPhoto.findUnique({ where: { id: r3.id } })), "DB 실패 시 사진 유지");
      assert(Boolean(await mem.head(r3.storageKey)), "DB 실패 시 객체 유지");
      // 취소 = 요청 없음 → 서버 변화 없음 (클라이언트 구조 확인)
      const form = read("src/app/community/FreeBoardForm.tsx");
      assert(!/method: "DELETE"/.test(form), "수정 화면에서 즉시 DELETE 호출 없음");
      assert(form.includes("removedPhotoIds: removedIds"), "저장 시 removedPhotoIds 전송");
      assert(form.lastIndexOf("uploadPendingPhotos(postId") > form.indexOf("isEdit ? { title, body"), "새 사진은 저장 성공 후 업로드 (취소 시 업로드 없음)");
    }

    section("post delete");
    assert((await DEL(req(`http://local/api/free-board/${pid}`, { method: "DELETE", headers: { cookie: B } }), idP(pid))).status === 403, "other delete 403");
    const second = await json(
      await CREATE(req("http://local/api/free-board", { method: "POST", headers: H(B), body: JSON.stringify({ title: "B글", body: "b" }) }))
    );
    postIds.push(Number(second.id));
    assert((await DEL(req(`http://local/api/free-board/${second.id}`, { method: "DELETE", headers: { cookie: ADM } }), idP(Number(second.id)))).status === 200, "admin delete others 200");
    assert((await DEL(req(`http://local/api/free-board/${pid}`, { method: "DELETE", headers: { cookie: A } }), idP(pid))).status === 200, "author delete 200");
    const gone = await prisma.freeBoardPost.findUnique({ where: { id: pid } });
    assert(gone?.deletedAt != null, "soft deleted");
    assert((await prisma.freeBoardPhoto.count({ where: { postId: pid } })) === 0, "photo rows cleaned");
    assert((await DETAIL(req(`http://local/api/free-board/${pid}`, { headers: { cookie: A } }), idP(pid))).status === 404, "deleted detail 404");
    assert((await cpost(A, "after delete")).status === 404, "comment on deleted 404");
    assert((await up(A, png())).status === 404, "photo on deleted 404");
    const l2 = await json(await LIST(req("http://local/api/free-board", { headers: { cookie: A } })));
    assert(!l2.posts.some((p: { id: number }) => p.id === pid), "deleted hidden from list");
  } finally {
    setFreeBoardStoreFactoryForTests(null);
    for (const [k, v] of Object.entries(prevEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    const threads = await prisma.commentThread.findMany({
      where: { targetType: "FREE_BOARD_POST", targetKey: { in: postIds.map(String) } },
    });
    await prisma.comment.deleteMany({ where: { threadId: { in: threads.map((t) => t.id) } } });
    await prisma.commentThread.deleteMany({ where: { id: { in: threads.map((t) => t.id) } } });
    await prisma.freeBoardPhoto.deleteMany({ where: { postId: { in: postIds } } });
    await prisma.freeBoardPost.deleteMany({ where: { id: { in: postIds } } });
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (caddyIds.length) await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    process.env.SESSION_SECRET = prevSecret;
    if (prevFlag === undefined) delete process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED;
    else process.env.NEXT_PUBLIC_FREE_BOARD_ENABLED = prevFlag;
  }
  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
