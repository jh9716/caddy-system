/**
 * Common Comments V1 — CourseReport only. local caddy_local.
 * 실행: npm run test:course-report-comment-unit
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
import { COMMENT_BODY_MAX } from "../src/lib/commentConstants";
import { parseCommentBody, canComposeComment, canSoftDeleteComment } from "../src/lib/comment";
import { POST as POST_REPORT } from "../src/app/api/course-reports/route";
import { DELETE as DELETE_REPORT } from "../src/app/api/course-reports/[id]/route";
import {
  GET as GET_COMMENTS,
  POST as POST_COMMENT,
} from "../src/app/api/course-reports/[id]/comments/route";
import { DELETE as DELETE_COMMENT } from "../src/app/api/course-reports/[id]/comments/[commentId]/route";

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

function commentParams(id: number, commentId: number) {
  return { params: { id: String(id), commentId: String(commentId) } };
}

async function jsonOf(res: Response) {
  return res.json().catch(() => ({}));
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "course-report-comment-unit-secret-32!!";

  const tag = `cmc_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const reportIds: number[] = [];
  const threadIds: number[] = [];

  section("source safety");
  {
    const files = [
      "src/lib/comment.ts",
      "src/lib/commentConstants.ts",
      "src/lib/courseReportComments.ts",
      "src/app/api/course-reports/[id]/comments/route.ts",
      "src/app/api/course-reports/[id]/comments/[commentId]/route.ts",
      "src/app/course-reports/[id]/CourseReportComments.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("deliverWebPush"), `${rel} no push`);
      assert(!src.includes("PushSubscription"), `${rel} no PushSubscription`);
      assert(!src.includes("@vercel/blob"), `${rel} no blob`);
      assert(!src.includes("parentId"), `${rel} no parentId`);
      assert(!src.includes("put("), `${rel} no blob put`);
    }
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("enum CommentTargetType"), "enum CommentTargetType");
    assert(schema.includes("COURSE_REPORT"), "COURSE_REPORT target");
    assert(schema.includes("BOARD_DATE"), "BOARD_DATE reserved");
    assert(schema.includes("NOTICE"), "NOTICE reserved");
    assert(schema.includes("model CommentThread"), "CommentThread");
    assert(schema.includes("model Comment {"), "Comment");
    assert(schema.includes("onDelete: Restrict"), "author Restrict");
    assert(!/model Comment \{[\s\S]*parentId/.test(schema), "Comment no parentId");
    const mig = read("prisma/migrations/20260919070000_comment_v1/migration.sql");
    assert(mig.includes('CREATE TYPE "CommentTargetType"'), "CREATE TYPE");
    assert(mig.includes('CREATE TABLE "CommentThread"'), "CREATE TABLE thread");
    assert(mig.includes('CREATE TABLE "Comment"'), "CREATE TABLE comment");
    assert(mig.includes("ON DELETE RESTRICT"), "FK Restrict");
    assert(mig.includes("ON DELETE CASCADE"), "thread cascade");
    assert(!/\bDROP\s+/.test(mig), "no DROP");
    assert(!fs.existsSync("src/app/api/notice/[id]/comments"), "no notice comments API");
    assert(!fs.existsSync("src/app/api/board/comments"), "no board comments API");
    const noticeUi = read("src/app/notice/[id]/page.tsx");
    assert(!noticeUi.includes("CourseReportComments"), "notice UI unchanged");
    const boardUi = read("src/app/board/page.tsx");
    assert(!boardUi.includes("CourseReportComments"), "board UI unchanged");
    const photoClient = read("src/lib/courseReportPhotoClient.ts");
    assert(photoClient.includes("uploadCourseReportPendingPhotos"), "photo client intact");
    const member = read("src/components/manage/MemberShell.tsx");
    assert(member.includes("memberNavItems"), "MemberShell intact");
    const manage = read("src/components/manage/ManageShell.tsx");
    assert(manage.includes("캐디 관리"), "ManageShell menus intact");
    const form = read("src/app/course-reports/CourseReportForm.tsx");
    assert(!form.includes("comments"), "form no comments");
    const commentLib = read("src/lib/comment.ts");
    assert(!commentLib.includes("stripHtml"), "no stripHtml");
    assert(!commentLib.includes("dangerouslySetInnerHTML"), "lib no innerHTML");
    assert(!/<\[\^>\]\*>/.test(commentLib), "no HTML tag strip regex");
    const commentUi = read("src/app/course-reports/[id]/CourseReportComments.tsx");
    assert(commentUi.includes("{item.body}"), "React text child body");
    assert(!commentUi.includes("dangerouslySetInnerHTML"), "UI no innerHTML");
    const deploy = read("scripts/maintenance/deploy-comment-v1-migration.ts");
    assert(deploy.includes("COMMENT_V1_20260919"), "maintenance confirm task-id");
    assert(deploy.includes('["migrate", "deploy"]'), "migrate deploy only");
    assert(!deploy.includes('["migrate", "dev"]'), "no migrate dev");
    assert(!deploy.includes('["migrate", "reset"]'), "no migrate reset");
    assert(!deploy.includes('["db", "push"]'), "no db push");
  }

  section("parse / auth helpers");
  {
    assert(parseCommentBody("  hello  ") === "hello", "trim body");
    try {
      parseCommentBody("   ");
      assert(false, "empty reject");
    } catch (e) {
      assert((e as { code?: string }).code === "empty", "empty code");
    }
    try {
      parseCommentBody("x".repeat(COMMENT_BODY_MAX + 1));
      assert(false, "1001 reject");
    } catch (e) {
      assert((e as { code?: string }).code === "too_long", "too_long code");
    }
    assert(parseCommentBody("<3") === "<3", "<3 preserved");
    assert(parseCommentBody("1 < 2") === "1 < 2", "1 < 2 preserved");
    assert(parseCommentBody("a > b") === "a > b", "a > b preserved");
    assert(parseCommentBody("<b>hi</b>") === "<b>hi</b>", "tags stored as plain text");
    assert(parseCommentBody("foo < bar > baz") === "foo < bar > baz", "angle brackets preserved");
    assert(canComposeComment({ role: "caddy", userId: 1 }) === true, "caddy compose");
    assert(canComposeComment({ role: "admin", userId: null }) === false, "env-only no compose");
    assert(
      canSoftDeleteComment({
        role: "caddy",
        userId: 1,
        authorUserId: 1,
        deletedAt: null,
      }),
      "own delete"
    );
    assert(
      !canSoftDeleteComment({
        role: "caddy",
        userId: 1,
        authorUserId: 2,
        deletedAt: null,
      }),
      "other no delete"
    );
    assert(
      canSoftDeleteComment({
        role: "admin",
        userId: 9,
        authorUserId: 2,
        deletedAt: null,
      }),
      "admin delete any"
    );
  }

  const caddyA = await prisma.caddy.create({
    data: {
      name: "댓글캐디A",
      team: "1조",
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
    },
  });
  const caddyB = await prisma.caddy.create({
    data: {
      name: "댓글캐디B",
      team: "2조",
      caddyType: "HOUSE",
      employmentStatus: "ACTIVE",
    },
  });
  caddyIds.push(caddyA.id, caddyB.id);
  const userCaddy = await prisma.user.create({
    data: {
      username: `${tag}_caddy`,
      password: hash,
      role: "caddy",
      caddyId: caddyA.id,
    },
  });
  const userLeader = await prisma.user.create({
    data: {
      username: `${tag}_leader`,
      password: hash,
      role: "leader",
      caddyId: caddyB.id,
    },
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
  assert(created.status === 201 || Number.isInteger(reportId), `report created status=${created.status}`);

  try {
    section("unauth");
    {
      const g = await GET_COMMENTS(
        req(`http://local/api/course-reports/${reportId}/comments`),
        reportParams(reportId)
      );
      const p = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ body: "x" }),
        }),
        reportParams(reportId)
      );
      const d = await DELETE_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments/1`, {
          method: "DELETE",
        }),
        commentParams(reportId, 1)
      );
      assert(g.status === 401, "unauth GET 401");
      assert(p.status === 401, "unauth POST 401");
      assert(d.status === 401, "unauth DELETE 401");
    }

    section("empty GET does not create thread");
    {
      const before = await prisma.commentThread.count({
        where: { targetType: "COURSE_REPORT", targetKey: String(reportId) },
      });
      const g = await GET_COMMENTS(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          headers: { cookie: caddyCookie },
        }),
        reportParams(reportId)
      );
      const body = await jsonOf(g);
      const after = await prisma.commentThread.count({
        where: { targetType: "COURSE_REPORT", targetKey: String(reportId) },
      });
      assert(g.status === 200, "empty GET 200");
      assert(Array.isArray(body.comments) && body.comments.length === 0, "empty []");
      assert(before === 0 && after === 0, "GET did not create thread");
    }

    section("create caddy/leader/admin");
    {
      const caddyPost = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            body: "캐디 댓글",
            authorUserId: 999999,
            threadId: 999999,
            targetKey: "spoof",
          }),
        }),
        reportParams(reportId)
      );
      const caddyJson = await jsonOf(caddyPost);
      assert(caddyPost.status === 201, "caddy POST 201");
      assert(caddyJson.comment?.authorUserId === userCaddy.id, "spoof author ignored");
      assert(caddyJson.comment?.authorDisplayName === "댓글캐디A", "caddy display name");
      assert(caddyJson.comment?.body === "캐디 댓글", "caddy body");

      const plainPost = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "<3 1 < 2 a > b <b>hi</b>" }),
        }),
        reportParams(reportId)
      );
      const plainJson = await jsonOf(plainPost);
      assert(plainPost.status === 201, "plain-text symbols POST 201");
      assert(
        plainJson.comment?.body === "<3 1 < 2 a > b <b>hi</b>",
        "plain-text symbols stored as-is"
      );
      const plainRow = await prisma.comment.findUnique({
        where: { id: Number(plainJson.comment.id) },
      });
      assert(
        plainRow?.body === "<3 1 < 2 a > b <b>hi</b>",
        "plain-text symbols in DB as-is"
      );

      const leaderPost = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: leaderCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "조장 댓글" }),
        }),
        reportParams(reportId)
      );
      const leaderJson = await jsonOf(leaderPost);
      assert(leaderPost.status === 201, "leader POST 201");
      assert(leaderJson.comment?.authorDisplayName === "댓글캐디B", "leader display name");

      const adminPost = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "관리자 댓글" }),
        }),
        reportParams(reportId)
      );
      const adminJson = await jsonOf(adminPost);
      assert(adminPost.status === 201, "admin POST 201");
      assert(adminJson.comment?.authorDisplayName === userAdmin.username, "admin username fallback");

      const threads = await prisma.commentThread.findMany({
        where: { targetType: "COURSE_REPORT", targetKey: String(reportId) },
      });
      assert(threads.length === 1, "single thread after 3 comments");
      threadIds.push(threads[0].id);

      const envPost = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: envAdminCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "env" }),
        }),
        reportParams(reportId)
      );
      assert(envPost.status === 403, "env-only admin POST 403");
    }

    section("validation");
    {
      const empty = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "   " }),
        }),
        reportParams(reportId)
      );
      const long = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "가".repeat(COMMENT_BODY_MAX + 1) }),
        }),
        reportParams(reportId)
      );
      assert(empty.status === 400, "empty 400");
      assert((await jsonOf(empty)).error === "empty", "empty error");
      assert(long.status === 400, "1001 400");
      assert((await jsonOf(long)).error === "too_long", "too_long error");
    }

    section("delete policy");
    {
      const mine = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "지울 댓글" }),
        }),
        reportParams(reportId)
      );
      const mineId = Number((await jsonOf(mine)).comment.id);
      const otherDel = await DELETE_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments/${mineId}`, {
          method: "DELETE",
          headers: { cookie: otherCookie },
        }),
        commentParams(reportId, mineId)
      );
      assert(otherDel.status === 403, "other user DELETE 403");

      const selfDel = await DELETE_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments/${mineId}`, {
          method: "DELETE",
          headers: { cookie: caddyCookie },
        }),
        commentParams(reportId, mineId)
      );
      assert(selfDel.status === 200, "own soft delete 200");
      const row = await prisma.comment.findUnique({ where: { id: mineId } });
      assert(row?.deletedAt != null, "deletedAt set");
      assert(row?.body === "지울 댓글", "body retained in DB");

      const listed = await GET_COMMENTS(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          headers: { cookie: otherCookie },
        }),
        reportParams(reportId)
      );
      const listedJson = await jsonOf(listed);
      const tomb = listedJson.comments.find((c: { id: number }) => c.id === mineId);
      assert(tomb?.deleted === true, "deleted flag");
      assert(tomb?.body == null, "deleted body hidden");
      assert(tomb?.authorDisplayName == null, "deleted author hidden");
      assert(tomb?.authorUserId == null, "deleted authorUserId hidden");

      const leaderMine = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: leaderCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "관리자 삭제 대상" }),
        }),
        reportParams(reportId)
      );
      const leaderMineId = Number((await jsonOf(leaderMine)).comment.id);
      const adminDel = await DELETE_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments/${leaderMineId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        commentParams(reportId, leaderMineId)
      );
      assert(adminDel.status === 200, "admin delete others 200");
    }

    section("missing / soft-deleted report");
    {
      const missing = await GET_COMMENTS(
        req("http://local/api/course-reports/99999999/comments", {
          headers: { cookie: caddyCookie },
        }),
        reportParams(99999999)
      );
      assert(missing.status === 404, "missing report GET 404");
      const missingPost = await POST_COMMENT(
        req("http://local/api/course-reports/99999999/comments", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "x" }),
        }),
        reportParams(99999999)
      );
      assert(missingPost.status === 404, "missing report POST 404");

      const delReport = await DELETE_REPORT(
        req(`http://local/api/course-reports/${reportId}`, {
          method: "DELETE",
          headers: { cookie: caddyCookie },
        }),
        reportParams(reportId)
      );
      // caddy can only delete RECEIVED own report — should work
      assert(delReport.status === 200, "soft-delete report");
      const g = await GET_COMMENTS(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          headers: { cookie: caddyCookie },
        }),
        reportParams(reportId)
      );
      const p = await POST_COMMENT(
        req(`http://local/api/course-reports/${reportId}/comments`, {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "after delete" }),
        }),
        reportParams(reportId)
      );
      assert(g.status === 404, "soft-deleted report comments GET 404");
      assert(p.status === 404, "soft-deleted report comments POST 404");
    }

    section("concurrent first comment");
    {
      const created2 = await POST_REPORT(
        req("http://local/api/course-reports", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag} 동시`,
            body: "본문",
            course: "LAKE",
            category: "CART_PATH",
          }),
        })
      );
      const id2 = Number((await jsonOf(created2)).id);
      reportIds.push(id2);
      const [a, b] = await Promise.all([
        POST_COMMENT(
          req(`http://local/api/course-reports/${id2}/comments`, {
            method: "POST",
            headers: { cookie: caddyCookie, "content-type": "application/json" },
            body: JSON.stringify({ body: "동시1" }),
          }),
          reportParams(id2)
        ),
        POST_COMMENT(
          req(`http://local/api/course-reports/${id2}/comments`, {
            method: "POST",
            headers: { cookie: leaderCookie, "content-type": "application/json" },
            body: JSON.stringify({ body: "동시2" }),
          }),
          reportParams(id2)
        ),
      ]);
      assert(a.status === 201 && b.status === 201, "concurrent both 201");
      const threads = await prisma.commentThread.findMany({
        where: { targetType: "COURSE_REPORT", targetKey: String(id2) },
      });
      assert(threads.length === 1, "concurrent thread 1");
      threadIds.push(threads[0].id);
      const n = await prisma.comment.count({ where: { threadId: threads[0].id } });
      assert(n === 2, "concurrent comments 2");
    }

    section("UI");
    {
      const ui = read("src/app/course-reports/[id]/CourseReportComments.tsx");
      assert(ui.includes("댓글을 입력하세요"), "placeholder");
      assert(ui.includes("COMMENT_DELETED_PLACEHOLDER"), "deleted copy");
      assert(ui.includes("confirm("), "delete confirm");
      assert(ui.includes("canDelete"), "own/admin delete gate");
      const css = read("src/app/globals.css");
      assert(css.includes(".course-report-comment-submit"), "submit css");
      assert(css.includes("min-height: 44px"), "44px submit");
      const page = read("src/app/course-reports/[id]/page.tsx");
      assert(page.includes("CourseReportPhotoGallery"), "photos still rendered");
      assert(page.includes("CourseReportDetailActions"), "actions still rendered");
    }
  } finally {
    if (threadIds.length) {
      await prisma.comment.deleteMany({ where: { threadId: { in: threadIds } } });
      await prisma.commentThread.deleteMany({ where: { id: { in: threadIds } } });
    }
    await prisma.commentThread.deleteMany({
      where: { targetType: "COURSE_REPORT", targetKey: { in: reportIds.map(String) } },
    });
    if (reportIds.length) {
      await prisma.courseReportPhoto.deleteMany({ where: { reportId: { in: reportIds } } });
      await prisma.courseReport.deleteMany({ where: { id: { in: reportIds } } });
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
