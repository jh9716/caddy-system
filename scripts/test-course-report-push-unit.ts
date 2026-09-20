/**
 * CourseReport Web Push V1. local caddy_local only.
 * Mock provider: no external push network.
 * 실행: npm run test:course-report-push-unit
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
  COURSE_REPORT_PUSH_AUDIT_ACTION,
  COURSE_REPORT_PUSH_AUDIT_ENTITY,
  COURSE_REPORT_PUSH_LOCK_NS,
  COURSE_REPORT_PUSH_TITLE_NEW,
  COURSE_REPORT_PUSH_TITLE_STATUS,
} from "../src/lib/courseReportPushConstants";
import {
  buildCourseReportNewPushPayload,
  buildCourseReportStatusPushPayload,
  courseReportPushTagNew,
  courseReportPushTagStatus,
  courseReportPushUrl,
} from "../src/lib/courseReportPushMessage";
import {
  notifyCourseReportCreated,
  notifyCourseReportStatusChanged,
  resolveCourseReportNewPushTargets,
  resolveCourseReportStatusPushTargets,
  sendCourseReportPush,
} from "../src/lib/courseReportPush";
import { POST as POST_REPORT } from "../src/app/api/course-reports/route";
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

function b64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}

function fakeP256(): string {
  const b = Buffer.alloc(65, 9);
  b[0] = 0x04;
  return b64url(b);
}

function fakePriv(): string {
  return b64url(Buffer.alloc(32, 7));
}

function fakeAuth(): string {
  return b64url(Buffer.alloc(16, 3));
}

function jsonHasSecrets(body: unknown): boolean {
  const s = JSON.stringify(body);
  return (
    /p256dh/i.test(s) ||
    /"auth"/i.test(s) ||
    /endpoint/i.test(s) ||
    /WEB_PUSH_VAPID_PRIVATE/i.test(s) ||
    /privateKey/i.test(s)
  );
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

async function jsonOf(res: Response) {
  return res.json().catch(() => ({}));
}

async function crPushAudits(reportId: number) {
  return prisma.$queryRaw<Array<{ id: number; payload: unknown }>>`
    SELECT id, payload FROM "Audit"
    WHERE action = ${COURSE_REPORT_PUSH_AUDIT_ACTION}
      AND entity = ${COURSE_REPORT_PUSH_AUDIT_ENTITY}
      AND payload->>'reportId' = ${String(reportId)}
    ORDER BY id ASC
  `;
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevPub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const prevSub = process.env.WEB_PUSH_SUBJECT;
  process.env.SESSION_SECRET = "course-report-push-unit-secret-32!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = fakePriv();
  process.env.WEB_PUSH_SUBJECT = "https://www.verthill.kr";

  const tag = `crp_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const reportIds: number[] = [];
  const subIds: number[] = [];

  section("source safety");
  {
    const files = [
      "src/lib/courseReportPush.ts",
      "src/lib/courseReportPushMessage.ts",
      "src/lib/courseReportPushConstants.ts",
      "src/app/api/course-reports/route.ts",
      "src/app/api/course-reports/[id]/status/route.ts",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("@vercel/blob"), `${rel} no blob`);
      assert(!src.includes("spreadsheet"), `${rel} no spreadsheet`);
      assert(!src.includes("kakao"), `${rel} no kakao`);
      assert(!src.includes("parentId"), `${rel} no parentId`);
    }
    const core = read("src/lib/courseReportPush.ts");
    assert(core.includes("deliverWebPushMappings"), "reuses delivery helper");
    assert(core.includes("pg_advisory_xact_lock"), "advisory lock");
    assert(core.includes("tx.audit.create"), "Prisma Audit INSERT in claim tx");
    assert(core.includes('payload->>\'kind\''), "Audit kind lookup");
    assert(
      core.indexOf("claimCourseReportPushSend(") < core.lastIndexOf("deliverWebPushMappings"),
      "claim before deliverWebPushMappings"
    );
    assert(!core.includes("pushSentAt"), "no CourseReport pushSentAt field");
    assert(core.includes("normalizeAppRole"), "admin role via normalizeAppRole");
    assert(!core.includes("caddyId snapshot"), "no caddy snapshot comment noise");
    assert(!/caddyId:\s*\{/.test(core), "recipients not by caddyId");
    const actions = read("src/app/course-reports/[id]/CourseReportDetailActions.tsx");
    assert(!actions.includes("push"), "no manual push button");
    assert(!actions.includes("알림 보내"), "no send copy");
    const schema = read("prisma/schema.prisma");
    assert(!/model CourseReport \{[\s\S]*pushSentAt/.test(schema), "CourseReport no pushSentAt");
    const migDirs = fs
      .readdirSync(path.resolve("prisma/migrations"))
      .filter((name) => /^\d{14}_/.test(name));
    assert(
      !migDirs.some((name) => name.includes("course_report") && name.includes("push")),
      "no CourseReport pushSentAt migration"
    );
    assert(
      !migDirs.some((name) => name > "20260919070000_comment_v1" && name.includes("course_report")),
      "no new course_report migration"
    );
    const commentFiles = [
      "src/lib/comment.ts",
      "src/lib/commentThread.ts",
      "src/lib/boardComments.ts",
      "src/app/board/BoardComments.tsx",
    ];
    for (const rel of commentFiles) {
      assert(!read(rel).includes("courseReportPush"), `${rel} comments untouched`);
    }
    const photo = read("src/lib/courseReportPhoto.ts");
    assert(!photo.includes("courseReportPush"), "photo logic untouched");
    assert(COURSE_REPORT_PUSH_LOCK_NS !== 1610001, "lock ns != board");
    assert(COURSE_REPORT_PUSH_LOCK_NS !== 1620001, "lock ns != notice");
    const created = read("src/app/api/course-reports/route.ts");
    assert(created.includes("notifyCourseReportCreated"), "create hooks NEW push");
    const statusSrc = read("src/app/api/course-reports/[id]/status/route.ts");
    assert(statusSrc.includes("notifyCourseReportStatusChanged"), "status hooks STATUS push");
    const payload = buildCourseReportNewPushPayload({
      reportId: 9,
      category: "SAFETY",
      course: "SKY",
      title: "벙커",
    });
    assert(payload.title === COURSE_REPORT_PUSH_TITLE_NEW, "NEW title");
    assert(payload.url === courseReportPushUrl(9), "NEW url");
    assert(payload.tag === courseReportPushTagNew(9), "NEW tag");
    assert(payload.body.includes("안전"), "NEW body category");
    assert(payload.body.includes("스카이"), "NEW body course");
    const st = buildCourseReportStatusPushPayload({
      reportId: 9,
      status: "CHECKING",
      title: "벙커",
    });
    assert(st.title === COURSE_REPORT_PUSH_TITLE_STATUS, "STATUS title");
    assert(st.tag === courseReportPushTagStatus(9), "STATUS tag");
    assert(st.body.includes("확인중"), "STATUS body label");
  }

  const caddyA = await prisma.caddy.create({
    data: { name: "푸시캐디A", team: "1조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
  });
  const caddyB = await prisma.caddy.create({
    data: { name: "푸시캐디B", team: "2조", caddyType: "HOUSE", employmentStatus: "ACTIVE" },
  });
  caddyIds.push(caddyA.id, caddyB.id);

  const userAdmin = await prisma.user.create({
    data: { username: `${tag}_admin`, password: hash, role: "admin" },
  });
  const userAdminUpper = await prisma.user.create({
    data: { username: `${tag}_ADMIN`, password: hash, role: "ADMIN" },
  });
  const userCaddy = await prisma.user.create({
    data: { username: `${tag}_caddy`, password: hash, role: "caddy", caddyId: caddyA.id },
  });
  const userLeader = await prisma.user.create({
    data: { username: `${tag}_leader`, password: hash, role: "leader", caddyId: caddyB.id },
  });
  userIds.push(userAdmin.id, userAdminUpper.id, userCaddy.id, userLeader.id);

  async function addSub(userId: number, mark: number) {
    const row = await prisma.pushSubscription.create({
      data: {
        userId,
        endpoint: `https://push.example/${tag}/${userId}/${mark}`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    subIds.push(row.id);
    return row;
  }

  const adminSub = await addSub(userAdmin.id, 1);
  const adminUpperSub = await addSub(userAdminUpper.id, 2);
  const caddySub = await addSub(userCaddy.id, 3);
  const leaderSub = await addSub(userLeader.id, 4);
  const disabledAdmin = await prisma.pushSubscription.create({
    data: {
      userId: userAdmin.id,
      endpoint: `https://push.example/${tag}/admin/disabled`,
      p256dh: fakeP256(),
      auth: fakeAuth(),
      enabled: false,
    },
  });
  subIds.push(disabledAdmin.id);

  const caddyCookie = await cookieFor({
    id: userCaddy.id,
    username: userCaddy.username,
    role: "caddy",
    sessionVersion: 0,
  });
  const adminCookie = await cookieFor({
    id: userAdmin.id,
    username: userAdmin.username,
    role: "admin",
    sessionVersion: 0,
  });

  async function createReportViaApi() {
    const res = await POST_REPORT(
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
    const body = await jsonOf(res);
    const id = Number(body.id ?? body.report?.id);
    reportIds.push(id);
    return { res, body, id };
  }

  try {
    section("NEW recipients are admin subscriptions only");
    {
      const { subscriptions, recipientUserIds } = await resolveCourseReportNewPushTargets(prisma);
      const ids = new Set(subscriptions.map((s) => s.id));
      assert(ids.has(adminSub.id), "admin sub included");
      assert(ids.has(adminUpperSub.id), "ADMIN role sub included");
      assert(!ids.has(caddySub.id), "caddy sub excluded from NEW");
      assert(!ids.has(leaderSub.id), "leader sub excluded from NEW");
      assert(!ids.has(disabledAdmin.id), "disabled admin sub excluded");
      assert(recipientUserIds.includes(userAdmin.id), "admin user recipient");
      assert(recipientUserIds.includes(userAdminUpper.id), "ADMIN user recipient");
      assert(!recipientUserIds.includes(userCaddy.id), "caddy not NEW recipient");
      assert(!recipientUserIds.includes(userLeader.id), "leader not NEW recipient");
    }

    section("STATUS recipients are authorUserId only");
    {
      const author = await resolveCourseReportStatusPushTargets(prisma, userCaddy.id);
      const ids = new Set(author.subscriptions.map((s) => s.id));
      assert(ids.has(caddySub.id), "author caddy sub included");
      assert(!ids.has(adminSub.id), "admin not STATUS recipient");
      assert(!ids.has(leaderSub.id), "leader not STATUS recipient");
      assert(author.recipientUserIds.length === 1 && author.recipientUserIds[0] === userCaddy.id, "only author");
    }

    section("payload / message");
    {
      const p = buildCourseReportNewPushPayload({
        reportId: 42,
        category: "SAFETY",
        course: "OCEAN",
        title: "배수로",
      });
      assert(p.url === "/course-reports/42", "url path");
      assert(p.tag === "course-report:42:new", "tag new");
      assert(p.body.includes("오션"), "ocean label");
    }

    section("NEW send admin only + duplicate blocked");
    {
      const created = await prisma.courseReport.create({
        data: {
          authorUserId: userCaddy.id,
          authorCaddyId: caddyA.id,
          authorDisplayName: "푸시캐디A",
          title: `${tag} NEW`,
          body: "본문",
          course: "SKY",
          category: "SAFETY",
        },
      });
      reportIds.push(created.id);
      const hits: Array<{ userId: number; json: string }> = [];
      const first = await sendCourseReportPush(
        prisma,
        { kind: "NEW", reportId: created.id },
        {
          sendFn: async (sub, json) => {
            const row = await prisma.pushSubscription.findFirst({
              where: { endpoint: sub.endpoint },
            });
            hits.push({ userId: row?.userId ?? 0, json });
          },
        }
      );
      assert(first.ok && first.sent === 2, `NEW sent admins only sent=${first.sent}`);
      assert(hits.length === 2, "two admin deliveries");
      assert(
        hits.every((h) => h.userId === userAdmin.id || h.userId === userAdminUpper.id),
        "NEW hits are admin userIds"
      );
      assert(
        hits.every((h) => JSON.parse(h.json).title === COURSE_REPORT_PUSH_TITLE_NEW),
        "NEW payload title"
      );
      assert(
        hits.every((h) => JSON.parse(h.json).url === `/course-reports/${created.id}`),
        "NEW payload url"
      );
      assert(!hits.some((h) => jsonHasSecrets(JSON.parse(h.json))), "payload no secrets");

      const audits = await crPushAudits(created.id);
      assert(audits.length === 1, "one NEW audit");
      const payload = audits[0]?.payload as Record<string, unknown>;
      assert(payload?.kind === "NEW", "audit kind NEW");
      assert(payload?.reportId === created.id, "audit reportId");
      assert(payload?.claim === "SENT", "audit claim SENT");
      assert(!jsonHasSecrets(payload), "audit no secrets");

      let secondHits = 0;
      const second = await sendCourseReportPush(
        prisma,
        { kind: "NEW", reportId: created.id },
        { sendFn: async () => { secondHits += 1; } }
      );
      assert(second.skipped === "already_sent", "duplicate NEW skipped");
      assert(secondHits === 0, "duplicate NEW no deliver");
      assert((await crPushAudits(created.id)).length === 1, "still one NEW audit");
    }

    section("STATUS author only + same status no resend + other status once");
    {
      const created = await prisma.courseReport.create({
        data: {
          authorUserId: userCaddy.id,
          authorCaddyId: caddyA.id,
          authorDisplayName: "푸시캐디A",
          title: `${tag} STATUS`,
          body: "본문",
          course: "LAKE",
          category: "FACILITY",
        },
      });
      reportIds.push(created.id);
      const hits: string[] = [];
      const checking = await notifyCourseReportStatusChanged(
        prisma,
        { reportId: created.id, previousStatus: "RECEIVED", nextStatus: "CHECKING" },
        {
          sendFn: async (sub, json) => {
            const row = await prisma.pushSubscription.findFirst({
              where: { endpoint: sub.endpoint },
            });
            assert(row?.userId === userCaddy.id, "STATUS delivered to author");
            hits.push(JSON.parse(json).tag);
          },
        }
      );
      assert(checking.ok && checking.sent === 1, "STATUS CHECKING sent 1");
      assert(hits[0] === `course-report:${created.id}:status`, "status tag");

      let repeatHits = 0;
      const same = await notifyCourseReportStatusChanged(
        prisma,
        { reportId: created.id, previousStatus: "CHECKING", nextStatus: "CHECKING" },
        { sendFn: async () => { repeatHits += 1; } }
      );
      assert(same.skipped === "same_status", "same status click skipped");
      assert(repeatHits === 0, "same status no deliver");

      let dupHits = 0;
      const dupClaim = await sendCourseReportPush(
        prisma,
        { kind: "STATUS", reportId: created.id, status: "CHECKING" },
        { sendFn: async () => { dupHits += 1; } }
      );
      assert(dupClaim.skipped === "already_sent", "same STATUS event already_sent");
      assert(dupHits === 0, "claimed STATUS not resent");

      const resolved = await notifyCourseReportStatusChanged(
        prisma,
        { reportId: created.id, previousStatus: "CHECKING", nextStatus: "RESOLVED" },
        { sendFn: async () => undefined }
      );
      assert(resolved.ok && resolved.sent === 1, "different STATUS sends once");
      const audits = await crPushAudits(created.id);
      const kinds = audits.map((a) => (a.payload as { kind?: string; status?: string }));
      assert(
        kinds.some((p) => p.kind === "STATUS" && p.status === "CHECKING"),
        "CHECKING audit"
      );
      assert(
        kinds.some((p) => p.kind === "STATUS" && p.status === "RESOLVED"),
        "RESOLVED audit"
      );
    }

    section("gone stale subscription deleted");
    {
      const created = await prisma.courseReport.create({
        data: {
          authorUserId: userCaddy.id,
          authorDisplayName: "푸시캐디A",
          title: `${tag} GONE`,
          body: "본문",
          course: "SKY",
          category: "OTHER",
        },
      });
      reportIds.push(created.id);
      const gone = await sendCourseReportPush(
        prisma,
        { kind: "STATUS", reportId: created.id, status: "RECEIVED" },
        {
          sendFn: async () => {
            const err = new Error("gone");
            (err as { statusCode?: number }).statusCode = 410;
            throw err;
          },
        }
      );
      assert(gone.removedStale === 1, "gone counted");
      const still = await prisma.pushSubscription.findUnique({ where: { id: caddySub.id } });
      assert(still == null, "gone subscription deleted");
      await addSub(userCaddy.id, 99);
    }

    section("credentials missing fail-safe");
    {
      const created = await prisma.courseReport.create({
        data: {
          authorUserId: userCaddy.id,
          authorDisplayName: "푸시캐디A",
          title: `${tag} NOCRED`,
          body: "본문",
          course: "SKY",
          category: "OTHER",
        },
      });
      reportIds.push(created.id);
      const pub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      const priv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      const subj = process.env.WEB_PUSH_SUBJECT;
      delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      delete process.env.WEB_PUSH_SUBJECT;
      let hits = 0;
      const r = await notifyCourseReportCreated(prisma, created.id, {
        sendFn: async () => { hits += 1; },
      });
      assert(r.skipped === "not_configured", "not_configured skip");
      assert(hits === 0, "no deliver without creds");
      assert((await crPushAudits(created.id)).length === 0, "no claim without creds");
      process.env.WEB_PUSH_VAPID_PUBLIC_KEY = pub;
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY = priv;
      process.env.WEB_PUSH_SUBJECT = subj;
    }

    section("HTTP create fail-safe + HTTP same status no extra STATUS");
    {
      delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
      const created = await createReportViaApi();
      assert(created.res.status === 200 || created.res.status === 201, "create still ok");
      assert(Number.isInteger(created.id), "report id");
      assert((await crPushAudits(created.id)).length === 0, "HTTP create without creds no audit");
      process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();

      const patchSame = await PATCH_STATUS(
        req(`http://local/api/course-reports/${created.id}/status`, {
          method: "PATCH",
          headers: { cookie: adminCookie, "content-type": "application/json" },
          body: JSON.stringify({ status: "RECEIVED" }),
        }),
        { params: { id: String(created.id) } }
      );
      assert(patchSame.status === 200, "same status PATCH 200");
      const statusAudits = (await crPushAudits(created.id)).filter((a) => {
        const p = a.payload as { kind?: string };
        return p.kind === "STATUS";
      });
      assert(statusAudits.length === 0, "same status HTTP no STATUS audit");
    }

    section("concurrent NEW claims once");
    {
      const created = await prisma.courseReport.create({
        data: {
          authorUserId: userCaddy.id,
          authorDisplayName: "푸시캐디A",
          title: `${tag} RACE`,
          body: "본문",
          course: "SKY",
          category: "SAFETY",
        },
      });
      reportIds.push(created.id);
      let hits = 0;
      const sendFn = async () => {
        hits += 1;
      };
      const [a, b] = await Promise.all([
        sendCourseReportPush(prisma, { kind: "NEW", reportId: created.id }, { sendFn }),
        sendCourseReportPush(prisma, { kind: "NEW", reportId: created.id }, { sendFn }),
      ]);
      const skipped = [a, b].filter((r) => r.skipped === "already_sent").length;
      const sentOk = [a, b].filter((r) => r.ok && !r.skipped).length;
      assert(sentOk === 1 && skipped === 1, "concurrent one send one skip");
      assert((await crPushAudits(created.id)).length === 1, "concurrent one audit");
      const winner = [a, b].find((r) => r.ok && !r.skipped);
      assert(winner?.sent === 2, "winning NEW still admin-only 2");
      assert(hits === 2, "concurrent deliver only winning admin pair");
    }
  } finally {
    await prisma.audit.deleteMany({
      where: {
        action: COURSE_REPORT_PUSH_AUDIT_ACTION,
        entity: COURSE_REPORT_PUSH_AUDIT_ENTITY,
        entityId: { in: reportIds.filter((n) => Number.isInteger(n)) },
      },
    });
    if (subIds.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: subIds } } });
    }
    await prisma.pushSubscription.deleteMany({ where: { userId: { in: userIds } } });
    if (reportIds.length) {
      await prisma.courseReportPhoto.deleteMany({ where: { reportId: { in: reportIds } } });
      await prisma.comment.deleteMany({
        where: { thread: { targetType: "COURSE_REPORT", targetKey: { in: reportIds.map(String) } } },
      });
      await prisma.commentThread.deleteMany({
        where: { targetType: "COURSE_REPORT", targetKey: { in: reportIds.map(String) } },
      });
      await prisma.courseReport.deleteMany({ where: { id: { in: reportIds } } });
    }
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (caddyIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } });
    }
    if (prevSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevPub == null) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv == null) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
    if (prevSub == null) delete process.env.WEB_PUSH_SUBJECT;
    else process.env.WEB_PUSH_SUBJECT = prevSub;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
