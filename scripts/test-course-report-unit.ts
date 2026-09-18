/**
 * CourseReport text-only V1. local caddy_local only.
 * 실행: npm run test:course-report-unit
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
import { isRetiredCaddySessionBlocked } from "../src/lib/auth";
import {
  parseCourseReportCreateBody,
  parseCourseReportHole,
  parseCourseReportStatusBody,
  parseCourseReportUpdateBody,
  resolvedAtForStatus,
} from "../src/lib/courseReport";
import {
  canChangeCourseReportStatus,
  canEditCourseReportContent,
  canSoftDeleteCourseReport,
} from "../src/lib/courseReportAccess";
import { shouldUseManageShellForCourseReport } from "../src/lib/boardNav";
import {
  GET as GET_LIST,
  POST as POST_REPORT,
} from "../src/app/api/course-reports/route";
import {
  GET as GET_ONE,
  PATCH as PATCH_ONE,
  DELETE as DELETE_ONE,
} from "../src/app/api/course-reports/[id]/route";
import { PATCH as PATCH_STATUS } from "../src/app/api/course-reports/[id]/status/route";

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

function params(id: number) {
  return { params: { id: String(id) } };
}

async function jsonOf(res: Response) {
  return res.json().catch(() => ({}));
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);

  const prevSecret = process.env.SESSION_SECRET;
  process.env.SESSION_SECRET = "course-report-unit-secret-32chars!!";

  const tag = `cr_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const reportIds: number[] = [];

  section("source safety");
  {
    const files = [
      "src/lib/courseReport.ts",
      "src/lib/courseReportAccess.ts",
      "src/lib/courseReportConstants.ts",
      "src/app/api/course-reports/route.ts",
      "src/app/api/course-reports/[id]/route.ts",
      "src/app/api/course-reports/[id]/status/route.ts",
      "src/app/course-reports/page.tsx",
      "src/app/course-reports/new/page.tsx",
      "src/app/course-reports/CourseReportForm.tsx",
      "src/app/course-reports/[id]/page.tsx",
      "src/app/course-reports/[id]/edit/page.tsx",
      "src/app/course-reports/[id]/CourseReportDetailActions.tsx",
      "src/app/course-reports/layout.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("deliverWebPush"), `${rel} no deliverWebPush`);
      assert(!src.includes("PushSubscription"), `${rel} no PushSubscription`);
      assert(!src.includes("@vercel/blob"), `${rel} no blob`);
      assert(!src.includes("multipart"), `${rel} no multipart`);
      assert(!src.includes("FormData"), `${rel} no FormData`);
      assert(!src.includes('type="file"'), `${rel} no file input`);
      assert(!src.includes("CourseReportPhoto"), `${rel} no photo model`);
      assert(!src.includes("CommentThread"), `${rel} no CommentThread`);
      assert(!src.includes("model Comment"), `${rel} no Comment`);
    }
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("model CourseReport"), "schema CourseReport");
    assert(schema.includes("enum CourseReportCategory"), "schema category enum");
    assert(schema.includes("enum CourseReportStatus"), "schema status enum");
    assert(!schema.includes("model CourseReportPhoto"), "no CourseReportPhoto");
    assert(!schema.includes("model Comment"), "no Comment");
    assert(!schema.includes("model CommentThread"), "no CommentThread");
    const mig = read("prisma/migrations/20260918140000_course_report_v1/migration.sql");
    assert(!/\bDROP\s+(TABLE|COLUMN|INDEX|TYPE)\b/i.test(mig), "migration no DROP");
    assert(mig.includes("CREATE TABLE \"CourseReport\""), "migration CREATE TABLE");
    assert(mig.includes("CREATE TYPE \"CourseReportCategory\""), "migration CREATE TYPE category");
    assert(mig.includes("ON DELETE RESTRICT"), "authorUserId Restrict");
    assert(mig.includes("ON DELETE SET NULL"), "authorCaddyId SetNull");
    const mw = read("src/middleware.ts");
    assert(mw.includes('"/course-reports"'), "middleware gates /course-reports");
    const layout = read("src/app/course-reports/layout.tsx");
    assert(layout.includes("ManageShell"), "admin layout reuses ManageShell");
    assert(
      layout.includes("shouldUseManageShellForCourseReport"),
      "layout gates ManageShell by role"
    );
    assert(!layout.includes("VERTHILL · Caddy"), "no standalone header");
    assert(shouldUseManageShellForCourseReport("admin") === true, "admin shell");
    assert(shouldUseManageShellForCourseReport("caddy") === false, "caddy no admin shell");
    assert(shouldUseManageShellForCourseReport("leader") === false, "leader no admin shell");
    const header = read("src/components/AppHeader.tsx");
    assert(header.includes('href="/course-reports"'), "AppHeader 제보 link");
    const shell = read("src/components/manage/ManageShell.tsx");
    assert(shell.includes('href: "/course-reports"'), "ManageShell 코스 제보");
    assert(!/BOTTOM[\s\S]*course-reports/.test(shell), "bottom nav not expanded");
    const listPage = read("src/app/course-reports/page.tsx");
    assert(listPage.includes('href="/course-reports/new"'), "list CTA href /course-reports/new");
    assert(listPage.includes("from \"next/link\""), "list uses Next Link");
    assert(!listPage.includes("<button"), "list CTA is not a nested button");
    assert(!listPage.includes("preventDefault"), "list has no preventDefault");
    assert(!listPage.includes("pointer-events: none"), "list has no pointer-events none");
    const newPage = read("src/app/course-reports/new/page.tsx");
    assert(
      !newPage.includes('redirect("/course-reports")'),
      "compose does not bounce env-only admin back to list"
    );
    assert(newPage.includes("CourseReportForm"), "compose renders form");
    assert(
      isRetiredCaddySessionBlocked({
        role: "caddy",
        caddyId: 1,
        employmentStatus: "RETIRED",
      }),
      "RETIRED caddy still blocked"
    );
    assert(
      !isRetiredCaddySessionBlocked({
        role: "admin",
        caddyId: 1,
        employmentStatus: "RETIRED",
      }),
      "RETIRED admin still allowed"
    );
  }

  section("validation helpers");
  {
    const created = parseCourseReportCreateBody({
      title: "  그린 손상  ",
      body: "8번 볼 마크",
      course: "SKY",
      hole: 8,
      category: "COURSE_CONDITION",
      authorUserId: 999,
      authorCaddyId: 888,
      authorDisplayName: "spoof",
      status: "RESOLVED",
    });
    assert(created.title === "그린 손상", "trim title");
    assert(created.course === "SKY", "course SKY");
    assert(created.hole === 8, "hole 8");
    assert(!("authorUserId" in created), "create parser drops author spoof");
    assert(parseCourseReportHole(null) === null, "hole null");
    assert(parseCourseReportHole("") === null, "hole empty");
    assert(parseCourseReportHole(1) === 1, "hole 1");
    assert(parseCourseReportHole(18) === 18, "hole 18");
    try {
      parseCourseReportHole(0);
      assert(false, "hole 0 should throw");
    } catch {
      assert(true, "hole 0 rejected");
    }
    try {
      parseCourseReportHole(19);
      assert(false, "hole 19 should throw");
    } catch {
      assert(true, "hole 19 rejected");
    }
    try {
      parseCourseReportHole(1.5);
      assert(false, "hole decimal should throw");
    } catch {
      assert(true, "hole decimal rejected");
    }
    try {
      parseCourseReportCreateBody({
        title: "t",
        body: "b",
        course: "WEST",
        category: "OTHER",
      });
      assert(false, "invalid course should throw");
    } catch (e) {
      assert(
        (e as { code?: string }).code === "invalid_course",
        "invalid course rejected"
      );
    }
    const updated = parseCourseReportUpdateBody({ title: "새 제목", status: "RESOLVED" });
    assert(updated.title === "새 제목", "update title");
    assert(updated.body === undefined, "update ignores missing body");
    assert(parseCourseReportStatusBody({ status: "CHECKING" }) === "CHECKING", "status parse");
    assert(resolvedAtForStatus("RESOLVED") instanceof Date, "RESOLVED sets resolvedAt");
    assert(resolvedAtForStatus("CHECKING") === null, "CHECKING clears resolvedAt");
    assert(
      canEditCourseReportContent({
        role: "caddy",
        userId: 1,
        authorUserId: 1,
        status: "RECEIVED",
        deletedAt: null,
      }),
      "author can edit RECEIVED"
    );
    assert(
      !canEditCourseReportContent({
        role: "caddy",
        userId: 1,
        authorUserId: 2,
        status: "RECEIVED",
        deletedAt: null,
      }),
      "other cannot edit"
    );
    assert(
      !canEditCourseReportContent({
        role: "caddy",
        userId: 1,
        authorUserId: 1,
        status: "CHECKING",
        deletedAt: null,
      }),
      "author cannot edit CHECKING"
    );
    assert(
      canEditCourseReportContent({
        role: "admin",
        userId: 9,
        authorUserId: 1,
        status: "CHECKING",
        deletedAt: null,
      }),
      "admin can edit CHECKING"
    );
    assert(
      canSoftDeleteCourseReport({
        role: "caddy",
        userId: 1,
        authorUserId: 1,
        status: "RECEIVED",
        deletedAt: null,
      }),
      "author can delete RECEIVED"
    );
    assert(
      canChangeCourseReportStatus({ role: "admin", deletedAt: null }),
      "admin can change status"
    );
    assert(
      !canChangeCourseReportStatus({ role: "caddy", deletedAt: null }),
      "caddy cannot change status"
    );
  }

  try {
    const caddy = await prisma.caddy.create({
      data: {
        name: `${tag}_caddy`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const otherCaddy = await prisma.caddy.create({
      data: {
        name: `${tag}_other`,
        team: "2조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const retiredC = await prisma.caddy.create({
      data: {
        name: `${tag}_ret`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "RETIRED",
      },
    });
    const leaderC = await prisma.caddy.create({
      data: {
        name: `${tag}_leader`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    caddyIds.push(caddy.id, otherCaddy.id, retiredC.id, leaderC.id);

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
        caddyId: otherCaddy.id,
        sessionVersion: 0,
      },
    });
    const uLeader = await prisma.user.create({
      data: {
        username: `${tag}_leader`,
        password: hash,
        role: "leader",
        caddyId: leaderC.id,
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
    userIds.push(uAdmin.id, uCaddy.id, uOther.id, uLeader.id, uRetired.id);

    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const caddyCookie = await cookieFor({ ...uCaddy, role: "caddy" });
    const otherCookie = await cookieFor({ ...uOther, role: "caddy" });
    const leaderCookie = await cookieFor({ ...uLeader, role: "leader" });
    const retiredCookie = await cookieFor({ ...uRetired, role: "caddy" });

    section("unauth / RETIRED");
    {
      const list = await GET_LIST(req("https://www.verthill.kr/api/course-reports"));
      assert(list.status === 401, "unauth list 401");
      const detail = await GET_ONE(
        req("https://www.verthill.kr/api/course-reports/1"),
        params(1)
      );
      assert(detail.status === 401, "unauth detail 401");
      const retiredList = await GET_LIST(
        req("https://www.verthill.kr/api/course-reports", {
          headers: { cookie: retiredCookie },
        })
      );
      assert(retiredList.status === 401, "RETIRED list 401");
    }

    section("create roles + spoof");
    {
      const caddyRes = await POST_REPORT(
        req("https://www.verthill.kr/api/course-reports", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}_caddy`,
            body: "캐디 제보",
            course: "VERTHILL",
            hole: 3,
            category: "SAFETY",
            authorUserId: uAdmin.id,
            authorCaddyId: otherCaddy.id,
            authorDisplayName: "해커",
          }),
        })
      );
      const caddyBody = await jsonOf(caddyRes);
      assert(caddyRes.status === 200, "caddy create 200");
      assert(typeof caddyBody.id === "number", "caddy create id");
      reportIds.push(caddyBody.id);
      assert(caddyBody.report.authorUserId === uCaddy.id, "server authorUserId");
      assert(caddyBody.report.authorCaddyId === caddy.id, "server authorCaddyId snapshot");
      assert(caddyBody.report.authorDisplayName === `${tag}_caddy`, "caddy name snapshot");
      assert(caddyBody.report.status === "RECEIVED", "default RECEIVED");

      const leaderRes = await POST_REPORT(
        req("https://www.verthill.kr/api/course-reports", {
          method: "POST",
          headers: { cookie: leaderCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}_leader`,
            body: "조장 제보",
            course: "OCEAN",
            category: "FACILITY",
          }),
        })
      );
      const leaderBody = await jsonOf(leaderRes);
      assert(leaderRes.status === 200, "leader create 200");
      assert(leaderBody.report.hole === null, "hole null allowed");
      reportIds.push(leaderBody.id);

      const adminRes = await POST_REPORT(
        req("https://www.verthill.kr/api/course-reports", {
          method: "POST",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}_admin`,
            body: "관리자 제보",
            course: "LAKE",
            hole: 18,
            category: "OTHER",
          }),
        })
      );
      const adminBody = await jsonOf(adminRes);
      assert(adminRes.status === 200, "admin create 200");
      assert(adminBody.report.authorDisplayName === `${tag}_admin`, "admin uses username");
      reportIds.push(adminBody.id);

      const badCourse = await POST_REPORT(
        req("https://www.verthill.kr/api/course-reports", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}_bad_course`,
            body: "x",
            course: "WEST",
            category: "OTHER",
          }),
        })
      );
      assert(badCourse.status === 400, "invalid course 400");
      const badHole = await POST_REPORT(
        req("https://www.verthill.kr/api/course-reports", {
          method: "POST",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({
            title: `${tag}_bad_hole`,
            body: "x",
            course: "SKY",
            hole: 19,
            category: "OTHER",
          }),
        })
      );
      assert(badHole.status === 400, "hole 19 400");
    }

    const caddyReportId = reportIds[0];
    const leaderReportId = reportIds[1];

    section("edit / delete permissions");
    {
      const okEdit = await PATCH_ONE(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}`, {
          method: "PATCH",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: `${tag}_caddy_edited`, hole: 4 }),
        }),
        params(caddyReportId)
      );
      const okBody = await jsonOf(okEdit);
      assert(okEdit.status === 200, "author RECEIVED edit 200");
      assert(okBody.title === `${tag}_caddy_edited`, "title updated");
      assert(okBody.hole === 4, "hole updated");

      const otherEdit = await PATCH_ONE(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}`, {
          method: "PATCH",
          headers: { cookie: otherCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: "stolen" }),
        }),
        params(caddyReportId)
      );
      assert(otherEdit.status === 403, "other edit 403");

      const otherDel = await DELETE_ONE(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}`, {
          method: "DELETE",
          headers: { cookie: otherCookie },
        }),
        params(caddyReportId)
      );
      assert(otherDel.status === 403, "other delete 403");

      const caddyStatus = await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}/status`, {
          method: "PATCH",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "CHECKING" }),
        }),
        params(caddyReportId)
      );
      assert(caddyStatus.status === 403, "caddy status 403");
    }

    section("admin status + author lock");
    {
      const checking = await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "CHECKING" }),
        }),
        params(caddyReportId)
      );
      const checkingBody = await jsonOf(checking);
      assert(checking.status === 200, "admin CHECKING 200");
      assert(checkingBody.status === "CHECKING", "status CHECKING");
      assert(checkingBody.resolvedAt === null, "CHECKING resolvedAt null");

      const authorLocked = await PATCH_ONE(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}`, {
          method: "PATCH",
          headers: { cookie: caddyCookie, "content-type": "application/json" },
          body: JSON.stringify({ title: "should fail" }),
        }),
        params(caddyReportId)
      );
      assert(authorLocked.status === 403, "author CHECKING edit 403");

      const resolved = await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "RESOLVED" }),
        }),
        params(caddyReportId)
      );
      const resolvedBody = await jsonOf(resolved);
      assert(resolved.status === 200, "admin RESOLVED 200");
      assert(typeof resolvedBody.resolvedAt === "string", "RESOLVED resolvedAt set");

      const reopen = await PATCH_STATUS(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "CHECKING" }),
        }),
        params(caddyReportId)
      );
      const reopenBody = await jsonOf(reopen);
      assert(reopen.status === 200, "admin reopen CHECKING 200");
      assert(reopenBody.resolvedAt === null, "reopen clears resolvedAt");

      const adminEdit = await PATCH_ONE(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ body: "관리자 수정" }),
        }),
        params(caddyReportId)
      );
      assert(adminEdit.status === 200, "admin edit after CHECKING 200");
    }

    section("soft delete");
    {
      const authorDel = await DELETE_ONE(
        req(`https://www.verthill.kr/api/course-reports/${leaderReportId}`, {
          method: "DELETE",
          headers: { cookie: leaderCookie },
        }),
        params(leaderReportId)
      );
      assert(authorDel.status === 200, "author RECEIVED soft delete 200");

      const list = await GET_LIST(
        req("https://www.verthill.kr/api/course-reports", {
          headers: { cookie: caddyCookie },
        })
      );
      const listBody = (await jsonOf(list)) as Array<{ id: number }>;
      assert(list.status === 200, "list 200");
      assert(
        Array.isArray(listBody) && !listBody.some((row) => row.id === leaderReportId),
        "soft-deleted hidden from list"
      );
      const secrets = JSON.stringify(listBody);
      assert(!/password/i.test(secrets), "list has no password");

      const gone = await GET_ONE(
        req(`https://www.verthill.kr/api/course-reports/${leaderReportId}`, {
          headers: { cookie: leaderCookie },
        }),
        params(leaderReportId)
      );
      assert(gone.status === 404, "soft-deleted detail 404");

      const adminDel = await DELETE_ONE(
        req(`https://www.verthill.kr/api/course-reports/${caddyReportId}`, {
          method: "DELETE",
          headers: { cookie: adminCookie },
        }),
        params(caddyReportId)
      );
      assert(adminDel.status === 200, "admin soft delete 200");
      const row = await prisma.courseReport.findUnique({ where: { id: caddyReportId } });
      assert(row?.deletedAt != null, "row still present with deletedAt");
    }
  } finally {
    if (reportIds.length) {
      await prisma.courseReport
        .deleteMany({ where: { id: { in: reportIds } } })
        .catch(() => undefined);
    }
    await prisma.courseReport
      .deleteMany({ where: { title: { startsWith: tag } } })
      .catch(() => undefined);
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
