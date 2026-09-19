/**
 * Board Comments V1 — BOARD_DATE on published dates only. local caddy_local.
 * 실행: npm run test:board-comment-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import { prisma } from "../src/lib/prisma";
import { parseYmd } from "../src/lib/availabilityEngine";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { COMMENT_BODY_MAX, COMMENT_TARGET } from "../src/lib/commentConstants";
import { parseBoardCommentDate } from "../src/lib/boardComments";
import { POST as POST_REPORT } from "../src/app/api/course-reports/route";
import {
  GET as GET_CR_COMMENTS,
  POST as POST_CR_COMMENT,
} from "../src/app/api/course-reports/[id]/comments/route";
import {
  GET as GET_COMMENTS,
  POST as POST_COMMENT,
} from "../src/app/api/board/[date]/comments/route";
import { DELETE as DELETE_COMMENT } from "../src/app/api/board/[date]/comments/[commentId]/route";

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

function dateParams(date: string) {
  return { params: { date } };
}

function commentParams(date: string, commentId: number) {
  return { params: { date, commentId: String(commentId) } };
}

function reportParams(id: number) {
  return { params: { id: String(id) } };
}

async function jsonOf(res: Response) {
  return res.json().catch(() => ({}));
}

function publishedPayload(ymd: string) {
  return {
    schemaVersion: 1,
    date: ymd,
    openCourses: [],
    placements: [],
    sparesByShift: [],
  };
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "board-comment-unit-secret-32chars!!";

  const tag = `bcd_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const pubDate = "2099-06-19";
  const unpublishedDate = "2099-06-18";
  const draftOnlyDate = "2099-06-17";
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const reportIds: number[] = [];
  const threadIds: number[] = [];
  let publishedCreated = false;
  let draftCreated = false;

  section("source safety");
  {
    const files = [
      "src/lib/boardComments.ts",
      "src/lib/commentThread.ts",
      "src/app/api/board/[date]/comments/route.ts",
      "src/app/api/board/[date]/comments/[commentId]/route.ts",
      "src/app/board/BoardComments.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("deliverWebPush"), `${rel} no push`);
      assert(!src.includes("PushSubscription"), `${rel} no PushSubscription`);
      assert(!src.includes("@vercel/blob"), `${rel} no blob`);
      assert(!src.includes("parentId"), `${rel} no parentId`);
      assert(!src.includes("put("), `${rel} no blob put`);
      assert(!src.includes("dangerouslySetInnerHTML"), `${rel} no innerHTML`);
      assert(!src.includes("stripHtml"), `${rel} no stripHtml`);
      assert(!src.includes("spreadsheet"), `${rel} no spreadsheet`);
    }
    const schema = read("prisma/schema.prisma");
    assert(schema.includes('BOARD_DATE'), "BOARD_DATE in schema");
    const migDirs = fs
      .readdirSync(path.resolve("prisma/migrations"))
      .filter((name) => /^\d{14}_/.test(name));
    assert(
      !migDirs.some((name) => name > "20260919070000_comment_v1" && name.includes("comment")),
      "no new comment migration"
    );
    assert(!fs.existsSync("src/app/api/notice/[id]/comments"), "no notice comments API");
    const boardPage = read("src/app/board/page.tsx");
    assert(boardPage.includes("PublishedBoardView"), "PublishedBoardView kept");
    assert(boardPage.includes("BoardComments"), "BoardComments mounted");
    assert(
      boardPage.indexOf("PublishedBoardView") < boardPage.indexOf("BoardComments"),
      "comments after board view"
    );
    assert(!boardPage.includes("CourseReportComments"), "board does not use CourseReportComments");
    const ui = read("src/app/board/BoardComments.tsx");
    assert(ui.includes("{item.body}"), "React text child");
    assert(ui.includes("등록된 댓글이 없습니다."), "empty copy");
    assert(ui.includes("COMMENT_DELETED_PLACEHOLDER"), "deleted placeholder");
    const css = read("src/app/globals.css");
    assert(css.includes(".board-comments"), "board comments css");
    assert(css.includes("min-height: 44px"), "44px touch");
    const crPage = read("src/app/course-reports/[id]/page.tsx");
    assert(crPage.includes("CourseReportComments"), "CourseReport comments kept");
    try {
      parseBoardCommentDate("2026-13-40");
      assert(false, "invalid month rejected");
    } catch (e) {
      assert((e as { code?: string }).code === "invalid_date", "invalid_date code");
    }
    try {
      parseBoardCommentDate("2026-02-30");
      assert(false, "invalid day rejected");
    } catch (e) {
      assert((e as { code?: string }).code === "invalid_date", "Feb 30 invalid");
    }
    assert(parseBoardCommentDate("2026-09-19") === "2026-09-19", "valid ymd");
  }

  const caddyA = await prisma.caddy.create({
    data: {
      name: "배치댓글캐디A",
      team: "1조",
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
    },
  });
  const caddyB = await prisma.caddy.create({
    data: {
      name: "배치댓글캐디B",
      team: "2조",
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
    },
  });
  caddyIds.push(caddyA.id, caddyB.id);
  const userCaddy = await prisma.user.create({
    data: { username: `${tag}_caddy`, password: hash, role: "caddy", caddyId: caddyA.id },
  });
  const userLeader = await prisma.user.create({
    data: { username: `${tag}_leader`, password: hash, role: "leader", caddyId: caddyB.id },
  });
  const userAdmin = await prisma.user.create({
    data: { username: `${tag}_admin`, password: hash, role: "admin" },
  });
  const userOther = await prisma.user.create({
    data: { username: `${tag}_other`, password: hash, role: "caddy" },
  });
  userIds.push(userCaddy.id, userLeader.id, userAdmin.id, userOther.id);

  const caddyCookie = await cookieFor({
    id: userCaddy.id,
    username: userCaddy.username,
    role: "caddy",
    sessionVersion: 0,
  });
  const leaderCookie = await cookieFor({
    id: userLeader.id,
    username: userLeader.username,
    role: "leader",
    sessionVersion: 0,
  });
  const adminCookie = await cookieFor({
    id: userAdmin.id,
    username: userAdmin.username,
    role: "admin",
    sessionVersion: 0,
  });
  const otherCookie = await cookieFor({
    id: userOther.id,
    username: userOther.username,
    role: "caddy",
    sessionVersion: 0,
  });
  const envAdminCookie = await cookieFor({
    id: null,
    username: "envadmin",
    role: "admin",
    sessionVersion: 0,
  });

  await prisma.comment.deleteMany({
    where: {
      thread: {
        targetType: "BOARD_DATE",
        targetKey: { in: [pubDate, unpublishedDate, draftOnlyDate, "2099-06-20"] },
      },
    },
  });
  await prisma.commentThread.deleteMany({
    where: {
      targetType: "BOARD_DATE",
      targetKey: { in: [pubDate, unpublishedDate, draftOnlyDate, "2099-06-20"] },
    },
  });
  await prisma.dailyBoardPublished.deleteMany({
    where: { date: { in: [parseYmd(pubDate).start, parseYmd("2099-06-20").start] } },
  });
  await prisma.dailyBoardDraft.deleteMany({
    where: { date: parseYmd(draftOnlyDate).start },
  });

  await prisma.dailyBoardPublished.create({
    data: {
      date: parseYmd(pubDate).start,
      payload: publishedPayload(pubDate),
      schemaVersion: 1,
      sourceDraftVersion: 1,
      publishedAt: new Date(),
    },
  });
  publishedCreated = true;
  await prisma.dailyBoardDraft.create({
    data: {
      date: parseYmd(draftOnlyDate).start,
      payload: { date: draftOnlyDate },
      schemaVersion: 1,
      version: 1,
    },
  });
  draftCreated = true;

  try {
    section("unauth");
    {
      const g = await GET_COMMENTS(
        req(`http://local/api/board/${pubDate}/comments`),
        dateParams(pubDate)
      );
      const p = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "x" }),
        }),
        dateParams(pubDate)
      );
      const d = await DELETE_COMMENT(
        req(`http://local/api/board/${pubDate}/comments/1`, { method: "DELETE" }),
        commentParams(pubDate, 1)
      );
      assert(g.status === 401, "unauth GET 401");
      assert(p.status === 401, "unauth POST 401");
      assert(d.status === 401, "unauth DELETE 401");
    }

    section("invalid date");
    {
      const bad = await GET_COMMENTS(
        req("http://local/api/board/2026-13-40/comments", {
          headers: { cookie: caddyCookie },
        }),
        dateParams("2026-13-40")
      );
      const badPost = await POST_COMMENT(
        req("http://local/api/board/not-a-date/comments", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "x" }),
        }),
        dateParams("not-a-date")
      );
      assert(bad.status === 400, "invalid GET 400");
      assert((await jsonOf(bad)).error === "invalid_date", "invalid_date GET");
      assert(badPost.status === 400, "invalid POST 400");
    }

    section("unpublished / draft-only 404");
    {
      const missing = await GET_COMMENTS(
        req(`http://local/api/board/${unpublishedDate}/comments`, {
          headers: { cookie: caddyCookie },
        }),
        dateParams(unpublishedDate)
      );
      const missingPost = await POST_COMMENT(
        req(`http://local/api/board/${unpublishedDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "x" }),
        }),
        dateParams(unpublishedDate)
      );
      const draftOnly = await GET_COMMENTS(
        req(`http://local/api/board/${draftOnlyDate}/comments`, {
          headers: { cookie: caddyCookie },
        }),
        dateParams(draftOnlyDate)
      );
      const draftPost = await POST_COMMENT(
        req(`http://local/api/board/${draftOnlyDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "x" }),
        }),
        dateParams(draftOnlyDate)
      );
      assert(missing.status === 404, "unpublished GET 404");
      assert((await jsonOf(missing)).error === "board_not_published", "unpublished code");
      assert(missingPost.status === 404, "unpublished POST 404");
      assert(draftOnly.status === 404, "draft-only GET 404");
      assert((await jsonOf(draftOnly)).error === "board_not_published", "draft-only code");
      assert(draftPost.status === 404, "draft-only POST 404");
      const leaked = await prisma.commentThread.count({
        where: { targetType: "BOARD_DATE", targetKey: { in: [unpublishedDate, draftOnlyDate] } },
      });
      assert(leaked === 0, "unpublished dates did not create thread");
    }

    section("published GET empty does not create thread");
    {
      const before = await prisma.commentThread.count({
        where: { targetType: "BOARD_DATE", targetKey: pubDate },
      });
      const g = await GET_COMMENTS(
        req(`http://local/api/board/${pubDate}/comments`, {
          headers: { cookie: caddyCookie },
        }),
        dateParams(pubDate)
      );
      const body = await jsonOf(g);
      const after = await prisma.commentThread.count({
        where: { targetType: "BOARD_DATE", targetKey: pubDate },
      });
      assert(g.status === 200, "empty GET 200");
      assert(Array.isArray(body.comments) && body.comments.length === 0, "empty []");
      assert(body.canCompose === true, "caddy canCompose");
      assert(before === 0 && after === 0, "GET did not create thread");
    }

    section("create caddy/leader/admin");
    {
      const caddyPost = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            body: "캐디 댓글",
            authorUserId: 999999,
            threadId: 999999,
            targetKey: "spoof",
          }),
        }),
        dateParams(pubDate)
      );
      const caddyJson = await jsonOf(caddyPost);
      assert(caddyPost.status === 201, "caddy POST 201");
      assert(caddyJson.comment?.authorUserId === userCaddy.id, "spoof author ignored");
      assert(caddyJson.comment?.authorDisplayName === "배치댓글캐디A", "caddy display name");
      assert(caddyJson.comment?.body === "캐디 댓글", "caddy body");

      const plain = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "<3 1 < 2 <b>hi</b>" }),
        }),
        dateParams(pubDate)
      );
      const plainJson = await jsonOf(plain);
      assert(plain.status === 201, "html-like POST 201");
      assert(plainJson.comment?.body === "<3 1 < 2 <b>hi</b>", "html-like stored as-is");

      const leaderPost = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: leaderCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "조장 댓글" }),
        }),
        dateParams(pubDate)
      );
      assert(leaderPost.status === 201, "leader POST 201");
      assert((await jsonOf(leaderPost)).comment?.authorDisplayName === "배치댓글캐디B", "leader name");

      const adminPost = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "관리자 댓글" }),
        }),
        dateParams(pubDate)
      );
      assert(adminPost.status === 201, "admin POST 201");

      const threads = await prisma.commentThread.findMany({
        where: { targetType: "BOARD_DATE", targetKey: pubDate },
      });
      assert(threads.length === 1, "single BOARD_DATE thread");
      threadIds.push(threads[0].id);

      const envPost = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: envAdminCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "env" }),
        }),
        dateParams(pubDate)
      );
      assert(envPost.status === 403, "env-only admin POST 403");
      const envGet = await GET_COMMENTS(
        req(`http://local/api/board/${pubDate}/comments`, {
          headers: { cookie: envAdminCookie },
        }),
        dateParams(pubDate)
      );
      assert((await jsonOf(envGet)).canCompose === false, "env-only canCompose false");
    }

    section("validation");
    {
      const empty = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "   " }),
        }),
        dateParams(pubDate)
      );
      const ok1000 = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "가".repeat(COMMENT_BODY_MAX) }),
        }),
        dateParams(pubDate)
      );
      const long = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "가".repeat(COMMENT_BODY_MAX + 1) }),
        }),
        dateParams(pubDate)
      );
      assert(empty.status === 400, "empty 400");
      assert(ok1000.status === 201, "1000 allowed");
      assert(long.status === 400, "1001 400");
      assert((await jsonOf(long)).error === "too_long", "too_long error");
    }

    section("delete policy");
    {
      const mine = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "지울 댓글" }),
        }),
        dateParams(pubDate)
      );
      const mineId = Number((await jsonOf(mine)).comment.id);
      const otherDel = await DELETE_COMMENT(
        req(`http://local/api/board/${pubDate}/comments/${mineId}`, {
          method: "DELETE",
          headers: { cookie: otherCookie },
        }),
        commentParams(pubDate, mineId)
      );
      assert(otherDel.status === 403, "other user DELETE 403");
      const selfDel = await DELETE_COMMENT(
        req(`http://local/api/board/${pubDate}/comments/${mineId}`, {
          method: "DELETE",
          headers: { cookie: caddyCookie },
        }),
        commentParams(pubDate, mineId)
      );
      assert(selfDel.status === 200, "own soft delete 200");
      const row = await prisma.comment.findUnique({ where: { id: mineId } });
      assert(row?.deletedAt != null, "deletedAt set");
      assert(row?.body === "지울 댓글", "body retained");
      const listed = await GET_COMMENTS(
        req(`http://local/api/board/${pubDate}/comments`, {
          headers: { cookie: otherCookie },
        }),
        dateParams(pubDate)
      );
      const tomb = (await jsonOf(listed)).comments.find((c: { id: number }) => c.id === mineId);
      assert(tomb?.deleted === true, "deleted flag");
      assert(tomb?.body == null, "deleted body hidden");
      assert(tomb?.authorDisplayName == null, "deleted author hidden");

      const leaderMine = await POST_COMMENT(
        req(`http://local/api/board/${pubDate}/comments`, {
          method: "POST",
          headers: { cookie: leaderCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "관리자 삭제 대상" }),
        }),
        dateParams(pubDate)
      );
      const leaderMineId = Number((await jsonOf(leaderMine)).comment.id);
      const adminDel = await DELETE_COMMENT(
        req(`http://local/api/board/${pubDate}/comments/${leaderMineId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        commentParams(pubDate, leaderMineId)
      );
      assert(adminDel.status === 200, "admin delete others 200");
    }

    section("concurrent first comment on second date");
    {
      const raceDate = "2099-06-20";
      await prisma.dailyBoardPublished.create({
        data: {
          date: parseYmd(raceDate).start,
          payload: publishedPayload(raceDate),
          schemaVersion: 1,
          sourceDraftVersion: 1,
          publishedAt: new Date(),
        },
      });
      const [a, b] = await Promise.all([
        POST_COMMENT(
          req(`http://local/api/board/${raceDate}/comments`, {
            method: "POST",
            headers: { cookie: caddyCookie, "content-type": "application/json" },
            body: JSON.stringify({ body: "race-a" }),
          }),
          dateParams(raceDate)
        ),
        POST_COMMENT(
          req(`http://local/api/board/${raceDate}/comments`, {
            method: "POST",
            headers: { cookie: leaderCookie, "content-type": "application/json" },
            body: JSON.stringify({ body: "race-b" }),
          }),
          dateParams(raceDate)
        ),
      ]);
      assert(a.status === 201 && b.status === 201, "concurrent both 201");
      const threads = await prisma.commentThread.findMany({
        where: { targetType: "BOARD_DATE", targetKey: raceDate },
      });
      assert(threads.length === 1, "concurrent thread 1");
      threadIds.push(threads[0].id);
      const n = await prisma.comment.count({ where: { threadId: threads[0].id } });
      assert(n === 2, "concurrent comments 2");
      await prisma.dailyBoardPublished.delete({ where: { date: parseYmd(raceDate).start } });
    }

    section("CourseReport thread isolation");
    {
      const created = await POST_REPORT(
        req("http://local/api/course-reports", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag} 제보`,
            body: "본문",
            course: "SKY",
            category: "SAFETY",
          }),
        })
      );
      const createdBody = await jsonOf(created);
      const reportId = Number(createdBody.id);
      reportIds.push(reportId);
      const crPost = await POST_CR_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "제보 댓글" }),
        }),
        reportParams(reportId)
      );
      assert(crPost.status === 201, "course-report POST 201");
      const boardThreads = await prisma.commentThread.findMany({
        where: { targetType: "BOARD_DATE", targetKey: pubDate },
      });
      const crThreads = await prisma.commentThread.findMany({
        where: { targetType: "COURSE_REPORT", targetKey: String(reportId) },
      });
      assert(boardThreads.length === 1, "board thread stays 1");
      assert(crThreads.length === 1, "course-report thread 1");
      assert(boardThreads[0].id !== crThreads[0].id, "threads are distinct");
      threadIds.push(crThreads[0].id);
      const crGet = await GET_CR_COMMENTS(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          headers: { cookie: caddyCookie },
        }),
        reportParams(reportId)
      );
      const crList = await jsonOf(crGet);
      assert(
        crList.comments.every((c: { body?: string }) => c.body !== "캐디 댓글"),
        "board bodies not in course-report thread"
      );
    }
  } finally {
    if (threadIds.length) {
      await prisma.comment.deleteMany({ where: { threadId: { in: threadIds } } });
      await prisma.commentThread.deleteMany({ where: { id: { in: threadIds } } });
    }
    await prisma.commentThread.deleteMany({
      where: {
        OR: [
          { targetType: "BOARD_DATE", targetKey: { in: [pubDate, unpublishedDate, draftOnlyDate, "2099-06-20"] } },
          { targetType: "COURSE_REPORT", targetKey: { in: reportIds.map(String) } },
        ],
      },
    });
    if (reportIds.length) {
      await prisma.courseReportPhoto.deleteMany({ where: { reportId: { in: reportIds } } });
      await prisma.courseReport.deleteMany({ where: { id: { in: reportIds } } });
    }
    if (publishedCreated) {
      await prisma.dailyBoardPublished.deleteMany({
        where: { date: { in: [parseYmd(pubDate).start, parseYmd("2099-06-20").start] } },
      });
    }
    if (draftCreated) {
      await prisma.dailyBoardDraft.deleteMany({
        where: { date: parseYmd(draftOnlyDate).start },
      });
    }
    if (userIds.length) await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    if (caddyIds.length) await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    process.env.SESSION_SECRET = prevSecret;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
