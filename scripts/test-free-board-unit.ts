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
  setCourseReportPhotoStoreForTests,
} from "../src/lib/courseReportPhotoStorage";

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
  const mem = createMemoryCourseReportPhotoStore();
  setCourseReportPhotoStoreForTests(mem);
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
    setCourseReportPhotoStoreForTests(null);
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
