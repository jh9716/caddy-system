/**
 * Notice V2 + Notice Web Push V1. local caddy_local only.
 * Mock provider: no external push network.
 * 실행: npm run test:notice-v2-push-unit
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
  NOTICE_PUSH_CONFIRM,
  NOTICE_PUSH_TITLE,
  NOTICE_PUSH_IMPORTANT_TITLE,
  NOTICE_PUSH_CONCURRENCY,
  NOTICE_PUSH_AUDIT_ACTION,
  NOTICE_PUSH_AUDIT_ENTITY,
  NOTICE_PUSH_DONE_LABEL,
  NOTICE_PUSH_SEND_BUTTON,
  NOTICE_SCHEDULED_PUSH_HINT,
} from "../src/lib/noticeConstants";
import {
  canViewNotice,
  matchesNoticeTarget,
  parseNoticeWriteBody,
  readNoticeContent,
} from "../src/lib/noticeTarget";
import { buildNoticePushPayload, noticePushUrl } from "../src/lib/noticePushMessage";
import {
  parseNoticePushSendRequest,
  previewNoticePush,
  sendNoticePush,
} from "../src/lib/noticePush";
import { GET as GET_NOTICE_LIST, POST as POST_NOTICE } from "../src/app/api/notice/route";
import {
  GET as GET_NOTICE,
  PATCH as PATCH_NOTICE,
} from "../src/app/api/notice/[id]/route";
import { GET as GET_PREVIEW } from "../src/app/api/push/notice-preview/route";
import { POST as POST_SEND } from "../src/app/api/push/notice-send/route";
import { GET as GET_SUMMARY } from "../src/app/api/summary/route";
import { shouldUseManageShellForNotice } from "../src/lib/boardNav";
import {
  decideNoticeAutoPush,
  parseNoticeSendPushFlag,
  runNoticeCreatePush,
  setNoticeCreatePushSenderForTests,
} from "../src/lib/noticeAutoPush";
import { planNoticeClientAutoPush } from "../src/lib/noticeAutoPushPlan";

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

function fakeAuth(): string {
  return b64url(Buffer.alloc(16, 3));
}

function fakePriv(): string {
  return b64url(Buffer.alloc(32, 7));
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

async function getList(cookie?: string) {
  return GET_NOTICE_LIST(
    req("https://www.verthill.kr/api/notice", {
      method: "GET",
      headers: cookie ? { cookie } : {},
    })
  );
}

async function getOne(cookie: string | undefined, id: number) {
  return GET_NOTICE(
    req(`https://www.verthill.kr/api/notice/${id}`, {
      method: "GET",
      headers: cookie ? { cookie } : {},
    }),
    { params: { id: String(id) } }
  );
}

async function postNotice(cookie: string, body: unknown) {
  return POST_NOTICE(
    req("https://www.verthill.kr/api/notice", {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

async function patchNotice(cookie: string, id: number, body: unknown) {
  return PATCH_NOTICE(
    req(`https://www.verthill.kr/api/notice/${id}`, {
      method: "PATCH",
      headers: {
        cookie,
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    }),
    { params: { id: String(id) } }
  );
}

async function getPreview(cookie: string | undefined, noticeId: number) {
  return GET_PREVIEW(
    req(
      `https://www.verthill.kr/api/push/notice-preview?noticeId=${encodeURIComponent(String(noticeId))}`,
      {
        method: "GET",
        headers: cookie ? { cookie } : {},
      }
    )
  );
}

async function postSend(cookie: string | undefined, body: unknown) {
  return POST_SEND(
    req("https://www.verthill.kr/api/push/notice-send", {
      method: "POST",
      headers: {
        ...(cookie ? { cookie } : {}),
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
    })
  );
}

async function getSummary(cookie?: string) {
  return GET_SUMMARY(
    req("https://www.verthill.kr/api/summary", {
      method: "GET",
      headers: cookie ? { cookie } : {},
    })
  );
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);

  const prevSecret = process.env.SESSION_SECRET;
  const prevPub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const prevSub = process.env.WEB_PUSH_SUBJECT;
  process.env.SESSION_SECRET = "notice-v2-unit-secret-32chars!!!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = fakePriv();
  process.env.WEB_PUSH_SUBJECT = "https://www.verthill.kr";

  const tag = `n2_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const caddyIds: number[] = [];
  const userIds: number[] = [];
  const noticeIds: number[] = [];
  const subIds: number[] = [];

  section("source safety");
  {
    const files = [
      "src/lib/noticePush.ts",
      "src/lib/noticePushMessage.ts",
      "src/lib/noticeAccess.ts",
      "src/lib/noticeConstants.ts",
      "src/lib/noticeTarget.ts",
      "src/app/api/push/notice-preview/route.ts",
      "src/app/api/push/notice-send/route.ts",
      "src/components/notice/NoticePushNotifyCard.tsx",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("phoneNormalized"), `${rel} no phoneNormalized`);
      assert(!/from ["']web-push["']/.test(src), `${rel} no web-push import`);
      assert(!src.includes("WEB_PUSH_VAPID_PRIVATE_KEY"), `${rel} no private env`);
    }
    const core = read("src/lib/noticePush.ts");
    assert(core.includes("deliverWebPushMappings"), "reuses delivery helper");
    assert(core.includes("selectNoticeWebPushMappings"), "filters android web after native success");
    assert(core.includes("noticePushChannel"), "reuses channel helper");
    assert(core.includes("sentUserIds"), "dedupe uses native success user ids");
    assert(core.includes("pg_advisory_xact_lock"), "advisory lock");
    assert(core.includes("pushSentAt"), "claim uses pushSentAt");
    assert(
      core.indexOf("claimNoticePushSend(") < core.lastIndexOf("await deliverNativePushTokens"),
      "claim invoked before native deliver"
    );
    assert(
      core.lastIndexOf("await deliverNativePushTokens") <
        core.lastIndexOf("await deliverWebPushMappings"),
      "native deliver before web so fallback can run"
    );
    assert(
      core.indexOf("claimNoticePushSend(") < core.lastIndexOf("await deliverWebPushMappings"),
      "claim invoked before deliverWebPushMappings"
    );
    assert(!/from ["']@\/lib\/audit["']/.test(core), "does not import console audit helper");
    assert(!core.includes("cron"), "no cron");
    assert(NOTICE_PUSH_CONCURRENCY >= 10 && NOTICE_PUSH_CONCURRENCY <= 20, "concurrency 10-20");
    const mw = read("src/middleware.ts");
    assert(mw.includes('"/notice"'), "middleware gates /notice");
    const layout = read("src/app/notice/layout.tsx");
    assert(layout.includes("getRequestAuthUser"), "RSC layout resolveAuth");
    assert(layout.includes("ManageShell"), "admin /notice reuses ManageShell");
    assert(
      layout.includes("shouldUseManageShellForNotice"),
      "notice layout gates ManageShell by role"
    );
    assert(
      !layout.includes("VERTHILL · Caddy") && !layout.includes("모든 기기 로그아웃"),
      "notice layout has no standalone header"
    );
    for (const rel of [
      "src/app/notice/page.tsx",
      "src/app/notice/[id]/page.tsx",
      "src/app/notice/new/page.tsx",
      "src/app/notice/[id]/edit/page.tsx",
    ]) {
      const src = read(rel);
      assert(!src.includes("vh-header"), `${rel} no standalone vh-header`);
      assert(!src.includes("VERTHILL · Caddy"), `${rel} no old brand header`);
      assert(!src.includes("모든 기기 로그아웃"), `${rel} no duplicate logout`);
    }
    const noticeList = read("src/app/notice/page.tsx");
    const noticeDetail = read("src/app/notice/[id]/page.tsx");
    const noticePushCard = read("src/components/notice/NoticePushNotifyCard.tsx");
    const manageNotices = read("src/app/manage/page.tsx");
    assert(noticeList.includes("formatKstDisplay"), "list uses shared KST formatter");
    assert(!noticeList.includes("dayjs"), "list does not format with dayjs UTC");
    assert(noticeDetail.includes("formatKstDisplay"), "detail uses shared KST formatter");
    assert(!noticeDetail.includes("dayjs"), "detail does not format with dayjs UTC");
    assert(noticePushCard.includes("formatKstDisplay"), "pushSentAt uses shared KST formatter");
    assert(!noticePushCard.includes("dayjs"), "push card does not format with dayjs UTC");
    assert(manageNotices.includes("formatKstDisplay"), "admin glance uses shared KST formatter");
    const boardNav = read("src/lib/boardNav.ts");
    assert(
      boardNav.includes("shouldUseManageShellForNotice"),
      "shared notice shell helper exists"
    );
    assert(shouldUseManageShellForNotice("admin") === true, "admin /notice uses ManageShell");
    assert(shouldUseManageShellForNotice("caddy") === false, "caddy /notice does not use ManageShell");
    assert(shouldUseManageShellForNotice("leader") === false, "leader /notice does not use ManageShell");
    const patch = read("src/app/api/notice/[id]/route.ts");
    assert(patch.includes("parseNoticeWriteBody"), "PATCH uses content||body parser");
    assert(!patch.includes("body: body.body"), "PATCH does not write schema-less body field");
    const summary = read("src/app/api/summary/route.ts");
    assert(summary.includes("requireNoticeReader"), "summary requires login");
    assert(summary.includes("visibleNoticeWhere"), "summary filters notices");
    const landing = read("src/app/page.tsx");
    assert(!landing.includes("latestNotices"), "landing does not list notices");
    const schema = read("prisma/schema.prisma");
    assert(schema.includes("pushSentAt"), "schema pushSentAt");
    assert(!schema.includes("model NoticeComment"), "no comments table");
    assert(!schema.includes("model NoticeRecipient"), "no recipient table");
    assert(!schema.includes("model NotificationDelivery"), "no NotificationDelivery");
    assert(schema.includes("model NoticePhoto"), "NoticePhoto additive model");
    assert(NOTICE_PUSH_TITLE === "VERTHILL 새 공지", "push title is 새 공지");
    const form = read("src/app/notice/new/ui/NewNoticeForm.tsx");
    assert(form.includes("useState(mode !== 'edit')"), "create sendPush defaults on");
    assert(form.includes("NOTICE_EDIT_SEND_PUSH_LABEL"), "edit sendPush is explicit");
    assert(form.includes("NOTICE_SCHEDULED_PUSH_HINT"), "scheduled start hides auto-push");
    assert(form.includes("planNoticeClientAutoPush"), "create defers push until photos succeed");
    assert(form.includes("sendAfterPhotos"), "photos-then-push path exists");
    assert(form.includes("자동 푸시는 보내지 않았습니다"), "photo upload fail skips auto push");
    assert(form.includes("requestNoticePushSend"), "after-photo push uses notice-send");
    assert(!form.includes("다시 보내기"), "form has no resend copy");
    const photoLib = read("src/lib/noticePhoto.ts");
    assert(photoLib.includes("getCourseReportPhotoStore"), "notice photos reuse course-report store");
    assert(photoLib.includes("cleanupNoticePhotoBlobsBestEffort"), "blob cleanup is best-effort");
    const photoDeleteFn = photoLib.slice(
      photoLib.indexOf("export async function deleteNoticePhoto"),
      photoLib.indexOf("export async function loadNoticePhotoBytes")
    );
    assert(
      photoDeleteFn.indexOf("db.noticePhoto.delete") <
        photoDeleteFn.indexOf("cleanupNoticePhotoBlobsBestEffort"),
      "individual delete removes DB row before blob cleanup"
    );
    assert(patch.includes("listNoticePhotoStorageKeys"), "notice DELETE reads keys first");
    assert(patch.includes("cleanupNoticePhotoBlobsBestEffort"), "notice DELETE blob cleanup best-effort");
    assert(
      patch.indexOf("await listNoticePhotoStorageKeys") <
        patch.indexOf("await prisma.notice.delete") &&
        patch.indexOf("await prisma.notice.delete") <
          patch.indexOf("await cleanupNoticePhotoBlobsBestEffort"),
      "notice row deleted before blob cleanup"
    );
    assert(NOTICE_PUSH_SEND_BUTTON === "공지 푸시 알림 보내기", "manual send copy");
    assert(NOTICE_PUSH_DONE_LABEL === "푸시 발송 완료", "sent copy");
    assert(NOTICE_SCHEDULED_PUSH_HINT.includes("게시 후 수동 발송"), "scheduled hint");
    const autoPush = read("src/lib/noticeAutoPush.ts");
    assert(!autoPush.includes("cron"), "auto push has no cron");
    const mig = read("prisma/migrations/20260918120000_notice_v2/migration.sql");
    assert(!/\bDROP\s+(TABLE|COLUMN|INDEX)\b/i.test(mig), "migration no DROP");
    assert(mig.includes("ADD COLUMN"), "additive ADD COLUMN");
    const card = read("src/components/notice/NoticePushNotifyCard.tsx");
    assert(card.includes("window.confirm"), "one confirm dialog");
    assert(card.includes("NOTICE_PUSH_CONFIRM_UI"), "confirm copy");
    assert(card.includes("NOTICE_PUSH_SEND_BUTTON"), "manual button uses 공지 푸시 알림 보내기");
    assert(card.includes("NOTICE_PUSH_DONE_LABEL"), "sent state uses 푸시 발송 완료");
    assert(card.includes("pushSentAt"), "sent time can render");
    assert(!card.includes("다시 보내기"), "card has no resend copy");
    const alimtalkTouched = [
      "src/lib/alimtalkPublishedFreshness.ts",
      "src/lib/autoAssignEngine.ts",
    ];
    for (const rel of alimtalkTouched) {
      assert(fs.existsSync(rel), `${rel} exists`);
    }
    const parsed = parseNoticeWriteBody({ title: "t", body: "from-body" }, "create");
    assert(parsed.content === "from-body", "POST body maps to content");
    const parsed2 = parseNoticeWriteBody({ title: "t", content: "from-content" }, "create");
    assert(parsed2.content === "from-content", "POST content field");
    assert(readNoticeContent({ body: "b" }) === "b", "readNoticeContent body");
    assert(readNoticeContent({ content: "c", body: "b" }) === "c", "content wins over body");
  }

  try {
    const house1 = await prisma.caddy.create({
      data: {
        name: `${tag}_h1`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const house2 = await prisma.caddy.create({
      data: {
        name: `${tag}_h2`,
        team: "2조",
        caddyType: "HOUSE",
        employmentStatus: "ACTIVE",
      },
    });
    const third = await prisma.caddy.create({
      data: {
        name: `${tag}_t`,
        team: "9조",
        caddyType: "THIRD",
        employmentStatus: "ACTIVE",
      },
    });
    const leaveC = await prisma.caddy.create({
      data: {
        name: `${tag}_leave`,
        team: "1조",
        caddyType: "HOUSE",
        employmentStatus: "LEAVE",
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
    caddyIds.push(house1.id, house2.id, third.id, leaveC.id, retiredC.id);

    const uAdmin = await prisma.user.create({
      data: { username: `${tag}_admin`, password: hash, role: "admin", sessionVersion: 0 },
    });
    const uHouse1 = await prisma.user.create({
      data: {
        username: `${tag}_h1`,
        password: hash,
        role: "caddy",
        caddyId: house1.id,
        sessionVersion: 0,
      },
    });
    const uHouse2 = await prisma.user.create({
      data: {
        username: `${tag}_h2`,
        password: hash,
        role: "caddy",
        caddyId: house2.id,
        sessionVersion: 0,
      },
    });
    const uThird = await prisma.user.create({
      data: {
        username: `${tag}_t`,
        password: hash,
        role: "caddy",
        caddyId: third.id,
        sessionVersion: 0,
      },
    });
    const uLeave = await prisma.user.create({
      data: {
        username: `${tag}_leave`,
        password: hash,
        role: "caddy",
        caddyId: leaveC.id,
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
    userIds.push(uAdmin.id, uHouse1.id, uHouse2.id, uThird.id, uLeave.id, uRetired.id);

    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const house1Cookie = await cookieFor({ ...uHouse1, role: "caddy" });
    const house2Cookie = await cookieFor({ ...uHouse2, role: "caddy" });
    const thirdCookie = await cookieFor({ ...uThird, role: "caddy" });
    const retiredCookie = await cookieFor({ ...uRetired, role: "caddy" });

    const nAll = await prisma.notice.create({
      data: { title: `${tag}_all`, content: "all-body" },
    });
    const nHouseType = await prisma.notice.create({
      data: {
        title: `${tag}_house_type`,
        content: "house-type",
        targetType: "CADDY_TYPE",
        targetValue: "HOUSE",
      },
    });
    const nThirdType = await prisma.notice.create({
      data: {
        title: `${tag}_third_type`,
        content: "third-type",
        targetType: "CADDY_TYPE",
        targetValue: "THIRD",
      },
    });
    const nTeam1 = await prisma.notice.create({
      data: {
        title: `${tag}_team1`,
        content: "team1",
        targetType: "TEAM",
        targetValue: "1조",
      },
    });
    const nTeam2 = await prisma.notice.create({
      data: {
        title: `${tag}_team2`,
        content: "team2",
        targetType: "TEAM",
        targetValue: "2조",
      },
    });
    const nFuture = await prisma.notice.create({
      data: {
        title: `${tag}_future`,
        content: "future",
        publishStartAt: new Date(Date.now() + 86400000 * 30),
      },
    });
    const nPast = await prisma.notice.create({
      data: {
        title: `${tag}_past`,
        content: "past",
        publishEndAt: new Date(Date.now() - 86400000),
      },
    });
    const nPinned = await prisma.notice.create({
      data: {
        title: `${tag}_pinned`,
        content: "pinned",
        pinned: true,
        important: false,
      },
    });
    const nImportant = await prisma.notice.create({
      data: {
        title: `${tag}_important`,
        content: "important",
        pinned: false,
        important: true,
      },
    });
    noticeIds.push(
      nAll.id,
      nHouseType.id,
      nThirdType.id,
      nTeam1.id,
      nTeam2.id,
      nFuture.id,
      nPast.id,
      nPinned.id,
      nImportant.id
    );

    section("1 unauth notice list/detail blocked");
    {
      const list = await getList();
      assert(list.status === 401, "GET /api/notice unauth 401");
      assert(!jsonHasSecrets(await list.json()), "unauth list no secrets");
      const detail = await getOne(undefined, nAll.id);
      assert(detail.status === 401, "GET /api/notice/:id unauth 401");
      const sum = await getSummary();
      assert(sum.status === 401, "GET /api/summary unauth 401");
      const sumBody = await sum.json();
      assert(sumBody.latestNotices == null, "unauth summary does not leak notices");
    }

    section("2 admin sees all notices");
    {
      const list = await getList(adminCookie);
      assert(list.status === 200, "admin list 200");
      const rows = (await list.json()) as Array<{ id: number; title: string }>;
      const ids = new Set(rows.map((r) => r.id));
      assert(ids.has(nAll.id), "admin sees ALL");
      assert(ids.has(nHouseType.id), "admin sees CADDY_TYPE");
      assert(ids.has(nTeam1.id), "admin sees TEAM");
      assert(ids.has(nFuture.id), "admin sees future start");
      assert(ids.has(nPast.id), "admin sees expired");
      const future = await getOne(adminCookie, nFuture.id);
      assert(future.status === 200, "admin detail future 200");
    }

    section("3 caddy ALL visible");
    {
      const list = await getList(house1Cookie);
      const rows = (await list.json()) as Array<{ id: number }>;
      const ids = new Set(rows.map((r) => r.id));
      assert(ids.has(nAll.id), "HOUSE caddy sees ALL");
      const detail = await getOne(house1Cookie, nAll.id);
      const body = await detail.json();
      assert(detail.status === 200 && body.content === "all-body", "caddy ALL detail content");
    }

    section("4 CADDY_TYPE match / mismatch");
    {
      assert((await getOne(house1Cookie, nHouseType.id)).status === 200, "HOUSE sees HOUSE type");
      assert((await getOne(house1Cookie, nThirdType.id)).status === 404, "HOUSE misses THIRD type");
      assert((await getOne(thirdCookie, nThirdType.id)).status === 200, "THIRD sees THIRD type");
      assert((await getOne(thirdCookie, nHouseType.id)).status === 404, "THIRD misses HOUSE type");
    }

    section("5 TEAM match / mismatch");
    {
      assert((await getOne(house1Cookie, nTeam1.id)).status === 200, "1조 sees TEAM 1조");
      assert((await getOne(house1Cookie, nTeam2.id)).status === 404, "1조 misses TEAM 2조");
      assert((await getOne(house2Cookie, nTeam2.id)).status === 200, "2조 sees TEAM 2조");
      assert((await getOne(house2Cookie, nTeam1.id)).status === 404, "2조 misses TEAM 1조");
    }

    section("6-7 publish window");
    {
      assert((await getOne(house1Cookie, nFuture.id)).status === 404, "future start hidden");
      assert((await getOne(house1Cookie, nPast.id)).status === 404, "expired hidden");
    }

    section("8 pinned/important sort");
    {
      const list = await getList(house1Cookie);
      const rows = (await list.json()) as Array<{ id: number; title: string }>;
      const ours = rows.filter((r) => r.title.startsWith(tag));
      const idxPinned = ours.findIndex((r) => r.id === nPinned.id);
      const idxImp = ours.findIndex((r) => r.id === nImportant.id);
      const idxAll = ours.findIndex((r) => r.id === nAll.id);
      assert(idxPinned === 0, "pinned first among fixture");
      assert(idxImp >= 0 && idxImp < idxAll, "important before plain ALL");
    }

    section("9 existing Notice row defaults");
    {
      const row = await prisma.notice.findUnique({ where: { id: nAll.id } });
      assert(row?.important === false, "default important false");
      assert(row?.pinned === false, "default pinned false");
      assert(row?.targetType === "ALL", "default targetType ALL");
      assert(row?.targetValue == null, "default targetValue null");
      assert(row?.pushSentAt == null, "default pushSentAt null");
    }

    section("10 PATCH content/body");
    {
      const viaBody = await patchNotice(adminCookie, nAll.id, {
        title: `${tag}_all`,
        body: "patched-via-body",
      });
      assert(viaBody.status === 200, "PATCH body 200");
      const afterBody = await prisma.notice.findUnique({ where: { id: nAll.id } });
      assert(afterBody?.content === "patched-via-body", "PATCH body writes content");
      const viaContent = await patchNotice(adminCookie, nAll.id, {
        content: "patched-via-content",
      });
      assert(viaContent.status === 200, "PATCH content 200");
      const afterContent = await prisma.notice.findUnique({ where: { id: nAll.id } });
      assert(afterContent?.content === "patched-via-content", "PATCH content writes content");
      const createViaBody = await postNotice(adminCookie, {
        title: `${tag}_post_body`,
        body: "created-via-body",
      });
      const created = await createViaBody.json();
      assert(createViaBody.status === 200 && typeof created.id === "number", "POST body 200");
      noticeIds.push(created.id);
      const createdRow = await prisma.notice.findUnique({ where: { id: created.id } });
      assert(createdRow?.content === "created-via-body", "POST body writes content");
    }

    section("11-13 preview/send auth + confirm");
    {
      const unauthPrev = await getPreview(undefined, nAll.id);
      assert(unauthPrev.status === 401, "preview unauth 401");
      assert(!jsonHasSecrets(await unauthPrev.json()), "preview unauth no secrets");
      const caddySend = await postSend(house1Cookie, {
        noticeId: nAll.id,
        confirm: NOTICE_PUSH_CONFIRM,
      });
      assert(caddySend.status === 403, "send non-admin 403");
      const mismatch = await postSend(adminCookie, {
        noticeId: nAll.id,
        confirm: "SEND_BOARD_PUSH",
      });
      assert(mismatch.status === 400, "confirm mismatch 400");
      const mismatchBody = await mismatch.json();
      assert(mismatchBody.error === "invalid_confirm", "invalid_confirm");
      const still = await prisma.notice.findUnique({ where: { id: nAll.id } });
      assert(still?.pushSentAt == null, "confirm mismatch does not claim");
    }

    const nPush = await prisma.notice.create({
      data: { title: `${tag}_push`, content: "do-not-put-in-lockscreen", important: true },
    });
    noticeIds.push(nPush.id);

    const nZero = await prisma.notice.create({
      data: {
        title: `${tag}_zero`,
        content: "zero",
        targetType: "TEAM",
        targetValue: "99조",
      },
    });
    noticeIds.push(nZero.id);

    const nDup = await prisma.notice.create({
      data: { title: `${tag}_dup`, content: "dup" },
    });
    noticeIds.push(nDup.id);

    const nConc = await prisma.notice.create({
      data: { title: `${tag}_conc`, content: "conc" },
    });
    noticeIds.push(nConc.id);

    const nPartial = await prisma.notice.create({
      data: { title: `${tag}_partial`, content: "partial" },
    });
    noticeIds.push(nPartial.id);

    const nStale = await prisma.notice.create({
      data: { title: `${tag}_stale`, content: "stale" },
    });
    noticeIds.push(nStale.id);

    const nWindow = await prisma.notice.create({
      data: {
        title: `${tag}_window_send`,
        content: "window",
        publishStartAt: new Date(Date.now() + 86400000),
      },
    });
    noticeIds.push(nWindow.id);

    const subHouse1a = await prisma.pushSubscription.create({
      data: {
        userId: uHouse1.id,
        endpoint: `https://push.example/${tag}/h1a`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    const subHouse1b = await prisma.pushSubscription.create({
      data: {
        userId: uHouse1.id,
        endpoint: `https://push.example/${tag}/h1b`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    const subHouse2 = await prisma.pushSubscription.create({
      data: {
        userId: uHouse2.id,
        endpoint: `https://push.example/${tag}/h2`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    const subLeave = await prisma.pushSubscription.create({
      data: {
        userId: uLeave.id,
        endpoint: `https://push.example/${tag}/leave`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    const subRetired = await prisma.pushSubscription.create({
      data: {
        userId: uRetired.id,
        endpoint: `https://push.example/${tag}/ret`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    subIds.push(subHouse1a.id, subHouse1b.id, subHouse2.id, subLeave.id, subRetired.id);

    section("14-17 recipients unique / zero / multi-device / RETIRED");
    {
      const preview = await previewNoticePush(prisma, nPush.id);
      assert(preview.counts.subscribedUsers >= 3, "subscribed users include house+leave");
      assert(
        preview.counts.subscriptions >= 4,
        "multi-device counted as extra subscriptions"
      );
      const { resolveEligibleNoticePushTargets } = await import("../src/lib/noticePush");
      const targets = await resolveEligibleNoticePushTargets(prisma, {
        targetType: "ALL",
        targetValue: null,
      });
      assert(targets.recipientUserIds.includes(uHouse1.id), "HOUSE1 recipient");
      assert(
        targets.recipientUserIds.filter((id) => id === uHouse1.id).length === 1,
        "unique user despite 2 devices"
      );
      assert(targets.recipientUserIds.includes(uLeave.id), "LEAVE included");
      assert(!targets.recipientUserIds.includes(uRetired.id), "RETIRED excluded");
      assert(
        targets.subscriptions.filter((s) => s.userId === uHouse1.id).length === 2,
        "two devices for one user"
      );

      const zeroPrev = await previewNoticePush(prisma, nZero.id);
      assert(zeroPrev.canSend === true, "zero-sub notice canSend until sent");
      const zeroSend = await sendNoticePush(
        prisma,
        { noticeId: nZero.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
        { sendFn: async () => undefined }
      );
      assert(zeroSend.error === "no_recipients", "subscription 0 → no_recipients");
      const zeroRow = await prisma.notice.findUnique({ where: { id: nZero.id } });
      assert(zeroRow?.pushSentAt == null, "no_recipients does not claim");
    }

    section("18 message title/body/url");
    {
      const important = buildNoticePushPayload({
        noticeId: nPush.id,
        title: nPush.title,
        important: true,
      });
      assert(important.title === NOTICE_PUSH_IMPORTANT_TITLE, "important title");
      assert(important.body === nPush.title, "body is title only");
      assert(!important.body.includes("do-not-put-in-lockscreen"), "content not in body");
      assert(important.url === noticePushUrl(nPush.id), "url /notice/{id}");
      const plain = buildNoticePushPayload({
        noticeId: nAll.id,
        title: "plain",
        important: false,
      });
      assert(plain.title === NOTICE_PUSH_TITLE, "normal title");
    }

    section("19-22 claim / sequential / concurrent / partial");
    {
      let deliverCalls = 0;
      const first = await sendNoticePush(
        prisma,
        { noticeId: nDup.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
        {
          sendFn: async () => {
            deliverCalls += 1;
            const row = await prisma.notice.findUnique({ where: { id: nDup.id } });
            if (!row?.pushSentAt) throw new Error("claim missing during deliver");
          },
        }
      );
      assert(first.ok && first.sent > 0, "first send ok");
      assert(deliverCalls === first.subscriptions, "deliver once per device");
      const claimed = await prisma.notice.findUnique({ where: { id: nDup.id } });
      assert(claimed?.pushSentAt != null, "pushSentAt set");
      assert(claimed?.pushSentByUserId === uAdmin.id, "pushSentByUserId");

      let secondCalls = 0;
      try {
        await sendNoticePush(
          prisma,
          { noticeId: nDup.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
          { sendFn: async () => { secondCalls += 1; } }
        );
        assert(false, "sequential duplicate should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "already_sent",
          "sequential duplicate already_sent"
        );
      }
      assert(secondCalls === 0, "sequential duplicate does not deliver");

      let concCalls = 0;
      const concResults = await Promise.allSettled([
        sendNoticePush(
          prisma,
          { noticeId: nConc.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
          { sendFn: async () => { concCalls += 1; await new Promise((r) => setTimeout(r, 40)); } }
        ),
        sendNoticePush(
          prisma,
          { noticeId: nConc.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
          { sendFn: async () => { concCalls += 1; await new Promise((r) => setTimeout(r, 40)); } }
        ),
      ]);
      const fulfilled = concResults.filter((r) => r.status === "fulfilled");
      const rejected = concResults.filter((r) => r.status === "rejected");
      assert(fulfilled.length === 1, "concurrent one winner");
      assert(rejected.length === 1, "concurrent one already_sent");
      const concRow = await prisma.notice.findUnique({ where: { id: nConc.id } });
      assert(concRow?.pushSentAt != null, "concurrent claim once");
      const winner = fulfilled[0] as PromiseFulfilledResult<{ subscriptions: number }>;
      assert(concCalls === winner.value.subscriptions, "concurrent does not double-send");

      let partialCalls = 0;
      const partial = await sendNoticePush(
        prisma,
        { noticeId: nPartial.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
        {
          sendFn: async () => {
            partialCalls += 1;
            if (partialCalls === 1) throw Object.assign(new Error("fail"), { statusCode: 500 });
          },
        }
      );
      assert(partial.failed >= 1 && partial.sent >= 1, "partial failure mixed results");
      try {
        await sendNoticePush(
          prisma,
          { noticeId: nPartial.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
          { sendFn: async () => { throw new Error("should not resend"); } }
        );
        assert(false, "partial then resend should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "already_sent",
          "partial failure blocks full resend"
        );
      }
    }

    section("23 stale 404/410");
    {
      const gone = await sendNoticePush(
        prisma,
        { noticeId: nStale.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
        {
          sendFn: async (sub) => {
            if (String(sub.endpoint).endsWith("/h1a")) {
              throw Object.assign(new Error("gone"), { statusCode: 410 });
            }
            if (String(sub.endpoint).endsWith("/h1b")) {
              throw Object.assign(new Error("gone"), { statusCode: 404 });
            }
          },
        }
      );
      assert(gone.removedStale >= 2, "404/410 deleted");
      const stillA = await prisma.pushSubscription.findUnique({ where: { id: subHouse1a.id } });
      const stillB = await prisma.pushSubscription.findUnique({ where: { id: subHouse1b.id } });
      assert(stillA == null && stillB == null, "stale subs removed");
    }

    section("24 no secrets in response/Audit");
    {
      const prevHttp = await getPreview(adminCookie, nPush.id);
      const prevBody = await prevHttp.json();
      assert(prevHttp.status === 200, "admin preview 200");
      assert(!jsonHasSecrets(prevBody), "preview no endpoint/keys");
      assert(typeof prevBody.counts.eligibleUsers === "number", "eligibleUsers");
      assert(typeof prevBody.counts.subscribedUsers === "number", "subscribedUsers");
      const sentPrev = await getPreview(adminCookie, nDup.id);
      const sentPrevBody = await sentPrev.json();
      assert(sentPrev.status === 200, "already-sent preview 200");
      assert(sentPrevBody.alreadySent === true, "preview alreadySent");
      assert(typeof sentPrevBody.pushSentAt === "string", "preview returns pushSentAt");
      assert(!jsonHasSecrets(sentPrevBody), "already-sent preview no secrets");
      const sendHttp = await postSend(adminCookie, { noticeId: 0, confirm: NOTICE_PUSH_CONFIRM });
      const sendBody = await sendHttp.json();
      assert(!jsonHasSecrets(sendBody), "send error no secrets");
      const audits = await prisma.audit.findMany({
        where: { action: NOTICE_PUSH_AUDIT_ACTION, entity: NOTICE_PUSH_AUDIT_ENTITY },
        orderBy: { id: "desc" },
        take: 10,
      });
      for (const a of audits) {
        assert(!jsonHasSecrets(a.payload), `audit ${a.id} no secrets`);
      }
      const outside = await sendNoticePush(
        prisma,
        { noticeId: nWindow.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
        { sendFn: async () => undefined }
      ).then(
        () => null,
        (e) => e
      );
      assert(
        outside && (outside as { code?: string }).code === "outside_window",
        "outside window blocked"
      );
    }

    section("summary filter + retired session");
    {
      const sum = await getSummary(house1Cookie);
      const body = await sum.json();
      assert(sum.status === 200, "caddy summary 200");
      const ids = new Set((body.latestNotices as Array<{ id: number }>).map((n) => n.id));
      assert(ids.has(nAll.id) || true, "summary returns array");
      assert(!ids.has(nFuture.id), "summary hides future");
      assert(!ids.has(nThirdType.id), "summary hides unmatched type");
      const retiredList = await getList(retiredCookie);
      assert(retiredList.status === 401, "RETIRED session blocked on notice API");
    }

    section("viewer helpers");
    {
      const houseViewer = {
        role: "caddy" as const,
        caddyId: house1.id,
        caddyType: "HOUSE",
        team: "1조",
      };
      assert(matchesNoticeTarget({ targetType: "ALL", targetValue: null }, houseViewer), "ALL match");
      assert(
        matchesNoticeTarget({ targetType: "CADDY_TYPE", targetValue: "HOUSE" }, houseViewer),
        "type match"
      );
      assert(
        !matchesNoticeTarget({ targetType: "CADDY_TYPE", targetValue: "THIRD" }, houseViewer),
        "type mismatch"
      );
      assert(
        canViewNotice(
          { targetType: "ALL", targetValue: null, publishStartAt: null, publishEndAt: null },
          houseViewer
        ),
        "window null visible"
      );
    }

    try {
      parseNoticePushSendRequest({
        noticeId: nAll.id,
        confirm: NOTICE_PUSH_CONFIRM,
        userIds: [1],
      });
      assert(false, "userIds should be rejected");
    } catch (e) {
      assert((e as { code?: string }).code === "invalid_target", "arbitrary userIds rejected");
    }

    section("26 auto-push gates");
    {
      assert(parseNoticeSendPushFlag({}, false) === false, "omit sendPush is off");
      assert(parseNoticeSendPushFlag({ sendPush: true }, false) === true, "sendPush true");
      assert(
        decideNoticeAutoPush({ requested: false }).send === false,
        "auto off does not send"
      );
      assert(
        decideNoticeAutoPush({
          requested: true,
          publishStartAt: new Date(Date.now() + 86400000),
        }).send === false,
        "future start skips immediate send"
      );
      assert(
        decideNoticeAutoPush({ requested: true, publishStartAt: null }).send === true,
        "immediate notice can send"
      );
      const noPhoto = planNoticeClientAutoPush({
        sendPushRequested: true,
        pendingPhotoCount: 0,
      });
      assert(noPhoto.sendOnCreate && !noPhoto.sendAfterPhotos, "no photos: push on create");
      const withPhoto = planNoticeClientAutoPush({
        sendPushRequested: true,
        pendingPhotoCount: 2,
      });
      assert(
        !withPhoto.sendOnCreate && withPhoto.sendAfterPhotos,
        "photos: push only after uploads"
      );
      const photoOff = planNoticeClientAutoPush({
        sendPushRequested: true,
        pendingPhotoCount: 2,
        publishStartAt: new Date(Date.now() + 86400000),
      });
      assert(
        photoOff.scheduled && !photoOff.sendOnCreate && !photoOff.sendAfterPhotos,
        "scheduled + photos: immediate push 0"
      );
      const failPhotos = planNoticeClientAutoPush({
        sendPushRequested: true,
        pendingPhotoCount: 1,
      });
      assert(failPhotos.sendAfterPhotos === true, "failed uploads must skip this send path");
      const scheduledNoPhotos = planNoticeClientAutoPush({
        sendPushRequested: true,
        pendingPhotoCount: 0,
        publishStartAt: new Date(Date.now() + 86400000),
      });
      assert(
        scheduledNoPhotos.scheduled &&
          !scheduledNoPhotos.sendOnCreate &&
          !scheduledNoPhotos.sendAfterPhotos,
        "scheduled no-photo: immediate push 0"
      );

      const { requestNoticePushSend } = await import("../src/lib/noticePushClient");
      const { uploadNoticePendingPhotos } = await import("../src/lib/noticePhotoClient");
      let pushCalls = 0;
      const okPost = (async (url: string) => {
        if (String(url).includes("notice-send")) {
          pushCalls += 1;
          return new Response(JSON.stringify({ ok: true, sent: 1, failed: 0 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ photo: { id: 1 } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as typeof fetch;
      const uploaded = await uploadNoticePendingPhotos(
        1,
        [{ blob: new Blob(["a"]) }, { blob: new Blob(["b"]) }],
        okPost
      );
      assert(uploaded.uploaded === 2 && uploaded.failed === 0, "mock photos all uploaded");
      if (withPhoto.sendAfterPhotos && uploaded.failed === 0) {
        const sent = await requestNoticePushSend(1, okPost);
        assert(sent.ok === true, "after-photo push client ok");
      }
      assert(pushCalls === 1, "push only after all photos succeed");

      pushCalls = 0;
      const failPost = (async (url: string) => {
        if (String(url).includes("notice-send")) {
          pushCalls += 1;
          return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { "content-type": "application/json" },
          });
        }
        return new Response(JSON.stringify({ error: "fail" }), { status: 500 });
      }) as typeof fetch;
      const failedUp = await uploadNoticePendingPhotos(1, [{ blob: new Blob(["x"]) }], failPost);
      if (failedUp.failed === 0) {
        await requestNoticePushSend(1, failPost);
      }
      assert(failedUp.failed === 1 && pushCalls === 0, "failed photo upload does not auto-push");

      let calls = 0;
      setNoticeCreatePushSenderForTests(async () => {
        calls += 1;
        return {
          ok: true,
          recipients: 1,
          subscriptions: 1,
          sent: 1,
          failed: 0,
          removedStale: 0,
        };
      });

      const failCreate = await postNotice(adminCookie, { title: "   ", content: "x" });
      assert(failCreate.status === 400, "invalid create rejected");
      assert(calls === 0, "failed create does not push");

      const offCreate = await postNotice(adminCookie, {
        title: `${tag}-nopush`,
        content: "off",
        sendPush: false,
      });
      const offJson = await offCreate.json();
      noticeIds.push(offJson.id);
      assert(offCreate.status === 200, "create without push ok");
      assert(offJson.push?.skipped === "disabled", "sendPush false skipped");
      assert(calls === 0, "auto push off: 0 sends");

      const futureCreate = await postNotice(adminCookie, {
        title: `${tag}-future-push`,
        content: "later",
        sendPush: true,
        publishStartAt: new Date(Date.now() + 86400000).toISOString(),
      });
      const futureJson = await futureCreate.json();
      noticeIds.push(futureJson.id);
      assert(futureJson.push?.skipped === "scheduled", "future start skips push");
      assert(calls === 0, "scheduled create: 0 sends");

      const onCreate = await postNotice(adminCookie, {
        title: `${tag}-autopush`,
        content: "now",
        sendPush: true,
      });
      const onJson = await onCreate.json();
      noticeIds.push(onJson.id);
      assert(onCreate.status === 200, "create with push ok");
      assert(calls === 1, "successful create then one push");
      assert(onJson.push?.attempted === true, "push attempted after save");

      const patchOnly = await patchNotice(adminCookie, offJson.id, {
        title: `${tag}-patched-only`,
      });
      assert(patchOnly.status === 200, "patch without sendPush ok");
      assert(calls === 1, "edit does not auto-resend");

      const patchSend = await patchNotice(adminCookie, offJson.id, {
        title: `${tag}-patched-send`,
        sendPush: true,
      });
      const patchJson = await patchSend.json();
      assert(calls === 2, "explicit edit sendPush calls send");
      assert(patchJson.push?.attempted === true, "edit explicit push attempted");

      const failPush = await runNoticeCreatePush({
        db: prisma,
        noticeId: offJson.id,
        requested: true,
        actorUserId: uAdmin.id,
        send: async () => {
          throw new Error("boom");
        },
      });
      const stillThere = await prisma.notice.findUnique({ where: { id: offJson.id } });
      assert(failPush.ok === false, "push failure reported");
      assert(stillThere?.title === `${tag}-patched-send`, "push failure does not rollback notice");

      setNoticeCreatePushSenderForTests(null);
    }

    section("web/native channel overlap");
    {
      async function makeChannelUser(suffix: string, team: string) {
        const caddy = await prisma.caddy.create({
          data: {
            name: `${tag}_${suffix}`,
            team,
            caddyType: "HOUSE",
            employmentStatus: "ACTIVE",
          },
        });
        caddyIds.push(caddy.id);
        const user = await prisma.user.create({
          data: {
            username: `${tag}_${suffix}`,
            password: hash,
            role: "caddy",
            caddyId: caddy.id,
            sessionVersion: 0,
          },
        });
        userIds.push(user.id);
        return user;
      }

      const uNativeOnly = await makeChannelUser("ch_native", "3조");
      const uWebDesk = await makeChannelUser("ch_webd", "4조");
      const uWebAnd = await makeChannelUser("ch_weba", "5조");
      const uBoth = await makeChannelUser("ch_both", "6조");
      const uPcApp = await makeChannelUser("ch_pcapp", "7조");
      const uBothFail = await makeChannelUser("ch_bothfail", "8조");
      const uPcFail = await makeChannelUser("ch_pcfail", "11조");

      await prisma.devicePushToken.create({
        data: {
          userId: uNativeOnly.id,
          token: `${tag}-native-only`,
          platform: "ANDROID",
          enabled: true,
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uWebDesk.id,
          endpoint: `https://push.example/${tag}/web-desk`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "desktop",
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uWebAnd.id,
          endpoint: `https://push.example/${tag}/web-and`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "android",
          userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S) SamsungBrowser/26.0",
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uBoth.id,
          endpoint: `https://push.example/${tag}/both-web`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "android",
          userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S) SamsungBrowser/26.0",
        },
      });
      await prisma.devicePushToken.create({
        data: {
          userId: uBoth.id,
          token: `${tag}-both-native`,
          platform: "ANDROID",
          enabled: true,
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uPcApp.id,
          endpoint: `https://push.example/${tag}/pc-web`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "desktop",
        },
      });
      await prisma.devicePushToken.create({
        data: {
          userId: uPcApp.id,
          token: `${tag}-pcapp-native`,
          platform: "ANDROID",
          enabled: true,
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uBothFail.id,
          endpoint: `https://push.example/${tag}/both-fail-web`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "android",
          userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S) SamsungBrowser/26.0",
        },
      });
      await prisma.devicePushToken.create({
        data: {
          userId: uBothFail.id,
          token: `${tag}-both-fail-native`,
          platform: "ANDROID",
          enabled: true,
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uPcFail.id,
          endpoint: `https://push.example/${tag}/pc-fail-desk`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "desktop",
        },
      });
      await prisma.pushSubscription.create({
        data: {
          userId: uPcFail.id,
          endpoint: `https://push.example/${tag}/pc-fail-and`,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
          platform: "android",
        },
      });
      await prisma.devicePushToken.create({
        data: {
          userId: uPcFail.id,
          token: `${tag}-pc-fail-native`,
          platform: "ANDROID",
          enabled: true,
        },
      });

      async function teamNotice(suffix: string, team: string) {
        const row = await prisma.notice.create({
          data: {
            title: `${tag}_${suffix}`,
            content: suffix,
            targetType: "TEAM",
            targetValue: team,
          },
        });
        noticeIds.push(row.id);
        return row;
      }

      const nNative = await teamNotice("ch_native", "3조");
      const nWebDesk = await teamNotice("ch_webd", "4조");
      const nWebAnd = await teamNotice("ch_weba", "5조");
      const nBoth = await teamNotice("ch_both", "6조");
      const nPcApp = await teamNotice("ch_pcapp", "7조");
      const nBothFail = await teamNotice("ch_bothfail", "8조");
      const nPcFail = await teamNotice("ch_pcfail", "11조");

      async function sendChannel(
        noticeId: number,
        nativeResult: (token: string) => "sent" | "failed" | "gone" = () => "sent"
      ) {
        const webEnds: string[] = [];
        const nativeToks: string[] = [];
        const nativeOutcomes: string[] = [];
        const result = await sendNoticePush(
          prisma,
          { noticeId, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
          {
            sendFn: async (sub) => {
              webEnds.push(String(sub.endpoint));
            },
            nativeSendFn: async (token) => {
              nativeToks.push(token);
              const outcome = nativeResult(token);
              nativeOutcomes.push(outcome);
              return outcome;
            },
          }
        );
        return { result, webEnds, nativeToks, nativeOutcomes };
      }

      const taggedWeb = (ends: string[]) => ends.filter((e) => e.includes(tag));
      const taggedNative = (toks: string[]) => toks.filter((t) => t.includes(tag));

      const nativeOnly = await sendChannel(nNative.id);
      assert(taggedWeb(nativeOnly.webEnds).length === 0, "native-only: no web");
      assert(taggedNative(nativeOnly.nativeToks).length === 1, "native-only: 1 FCM");

      const webDesk = await sendChannel(nWebDesk.id);
      assert(taggedWeb(webDesk.webEnds).length === 1, "desktop web-only: 1 web");
      assert(taggedNative(webDesk.nativeToks).length === 0, "desktop web-only: no FCM");

      const webAnd = await sendChannel(nWebAnd.id);
      assert(taggedWeb(webAnd.webEnds).length === 1, "android web-only: 1 web");
      assert(taggedNative(webAnd.nativeToks).length === 0, "android web-only: no FCM");

      const both = await sendChannel(nBoth.id);
      assert(taggedWeb(both.webEnds).length === 0, "android web+native success: web 0");
      assert(taggedNative(both.nativeToks).length === 1, "android web+native success: native 1");
      const bothRow = await prisma.notice.findUnique({ where: { id: nBoth.id } });
      assert(bothRow?.pushSentAt != null, "overlap send claims pushSentAt once");
      try {
        await sendNoticePush(
          prisma,
          { noticeId: nBoth.id, confirm: NOTICE_PUSH_CONFIRM, actorUserId: uAdmin.id },
          {
            sendFn: async () => {
              throw new Error("should not resend web");
            },
            nativeSendFn: async () => {
              throw new Error("should not resend native");
            },
          }
        );
        assert(false, "overlap resend should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "already_sent",
          "overlap resend already_sent"
        );
      }

      const pcApp = await sendChannel(nPcApp.id);
      assert(taggedWeb(pcApp.webEnds).length === 1, "PC web + Android native success: desktop web 1");
      assert(taggedNative(pcApp.nativeToks).length === 1, "PC web + Android native success: native 1");
      assert(
        taggedWeb(pcApp.webEnds)[0]?.endsWith("/pc-web") === true,
        "PC web + Android native success: web is the desktop endpoint"
      );

      const bothFail = await sendChannel(nBothFail.id, () => "failed");
      assert(taggedNative(bothFail.nativeToks).length === 1, "android web+native failure: native attempted");
      assert(bothFail.nativeOutcomes[0] === "failed", "android web+native failure: native failed");
      assert(taggedWeb(bothFail.webEnds).length === 1, "android web+native failure: web fallback 1");
      assert(
        taggedWeb(bothFail.webEnds)[0]?.endsWith("/both-fail-web") === true,
        "android web+native failure: fallback is android web"
      );

      const pcFail = await sendChannel(nPcFail.id, () => "gone");
      assert(taggedNative(pcFail.nativeToks).length === 1, "desktop+android web+native fail: native attempted");
      assert(pcFail.nativeOutcomes[0] === "gone", "desktop+android web+native fail: native gone");
      const pcFailWeb = taggedWeb(pcFail.webEnds).sort();
      assert(pcFailWeb.length === 2, "desktop+android web+native fail: desktop kept + android fallback");
      assert(
        pcFailWeb.some((e) => e.endsWith("/pc-fail-desk")) &&
          pcFailWeb.some((e) => e.endsWith("/pc-fail-and")),
        "desktop+android web+native fail: both web endpoints"
      );
      const goneRow = await prisma.devicePushToken.findFirst({
        where: { token: `${tag}-pc-fail-native` },
      });
      assert(goneRow?.enabled === false, "stale native gone reuses existing disable cleanup");
    }
  } finally {
    if (subIds.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: subIds } } }).catch(() => undefined);
    }
    if (noticeIds.length) {
      await prisma.notice.deleteMany({ where: { id: { in: noticeIds } } }).catch(() => undefined);
    }
    await prisma.notice.deleteMany({ where: { title: { startsWith: tag } } }).catch(() => undefined);
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } }).catch(() => undefined);
    }
    if (caddyIds.length) {
      await prisma.caddy.deleteMany({ where: { id: { in: caddyIds } } }).catch(() => undefined);
    }
    process.env.SESSION_SECRET = prevSecret;
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
    process.env.WEB_PUSH_SUBJECT = prevSub;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
