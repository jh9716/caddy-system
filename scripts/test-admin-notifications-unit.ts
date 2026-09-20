/**
 * Admin device Web Push registration V1. local caddy_local only.
 * Mock: no Notification.requestPermission, no network web-push.
 * 실행: npm run test:admin-notifications-unit
 */
import fs from "node:fs";
import path from "path";
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
  isEnvOnlyNonAdmin,
  resolvePushSubscriptionUserId,
} from "../src/lib/adminPushUser";
import {
  ADMIN_PUSH_UI_DENIED,
  ADMIN_PUSH_UI_DISABLE,
  ADMIN_PUSH_UI_DISABLE_HINT,
  ADMIN_PUSH_UI_ENABLE,
  ADMIN_PUSH_UI_REGISTERED,
  ADMIN_PUSH_UI_UNREGISTERED,
  adminPushSurfaceStatus,
} from "../src/lib/adminPushNotificationUi";
import { parsePushSubscriptionInput } from "../src/lib/pushSubscriptionStore";
import { GET, POST, DELETE } from "../src/app/api/push/subscription/route";

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

function validBody(endpoint: string) {
  return {
    endpoint,
    keys: { p256dh: fakeP256(), auth: fakeAuth() },
  };
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

async function jsonReq(
  method: string,
  cookie: string | undefined,
  body?: unknown,
  extraHeaders?: Record<string, string>
) {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method,
    headers: {
      ...(cookie ? { cookie } : {}),
      ...(body !== undefined ? { "content-type": "application/json" } : {}),
      ...extraHeaders,
    },
  };
  if (body !== undefined) init.body = JSON.stringify(body);
  const req = new NextRequest("https://www.verthill.kr/api/push/subscription", init);
  if (method === "GET") return GET(req);
  if (method === "POST") return POST(req);
  return DELETE(req);
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevPub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  process.env.SESSION_SECRET = process.env.SESSION_SECRET || "admin-push-v1-secret-32chars-min!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = b64url(Buffer.alloc(32, 7));

  section("source safety");
  {
    const files = [
      "src/lib/adminPushUser.ts",
      "src/lib/adminPushNotificationUi.ts",
      "src/app/manage/notifications/page.tsx",
      "src/app/api/push/subscription/route.ts",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("@vercel/blob"), `${rel} no blob`);
      assert(!src.includes("spreadsheet"), `${rel} no spreadsheet`);
      assert(!src.includes("kakao"), `${rel} no kakao`);
      assert(!/findFirst\(/.test(src), `${rel} no findFirst`);
      assert(!/userId:\s*1\b/.test(src) && !/id:\s*1\b/.test(src), `${rel} no hardcoded id=1`);
    }
    const resolveSrc = read("src/lib/adminPushUser.ts");
    assert(resolveSrc.includes("findUnique"), "exact username findUnique");
    assert(resolveSrc.includes('normalizeAppRole(row.role) !== "admin"'), "DB role must be admin");
    assert(resolveSrc.includes("row.username !== username"), "exact username re-check");
    assert(resolveSrc.includes('normalizeAppRole(auth.role) !== "admin"'), "caddy/leader no fallback");
    assert(!read("prisma/schema.prisma").includes("adminPush"), "no schema model");
    const migrations = fs.readdirSync("prisma/migrations");
    assert(!migrations.some((m) => /admin.?push|notification/i.test(m)), "no new migration dir");
    assert(!read("src/lib/courseReportPush.ts").includes("adminPushUser"), "courseReportPush untouched");
    assert(!read("src/lib/comment.ts").includes("adminPushUser"), "comment untouched");
    assert(!read("src/lib/commentThread.ts").includes("adminPushUser"), "commentThread untouched");
    assert(!read("src/lib/boardComments.ts").includes("adminPushUser"), "boardComments untouched");
    assert(!read("src/lib/courseReportPhoto.ts").includes("adminPushUser"), "photo untouched");
    assert(!read("src/lib/noticePush.ts").includes("adminPushUser"), "noticePush untouched");
    assert(!read("src/lib/boardPush.ts").includes("adminPushUser"), "boardPush untouched");
    const page = read("src/app/manage/notifications/page.tsx");
    assert(page.includes("PushNotificationCard"), "reuses PushNotificationCard");
    assert(page.includes(ADMIN_PUSH_UI_ENABLE) || page.includes("ADMIN_PUSH_UI_ENABLE"), "enable copy");
    assert(page.includes("ManageShell") === false, "page uses layout ManageShell");
    const shell = read("src/components/manage/ManageShell.tsx");
    assert(shell.includes('href: "/manage/notifications"'), "nav 알림 설정");
    const member = read("src/components/manage/MemberShell.tsx");
    assert(!member.includes("/manage/notifications"), "member shell no admin notifications");
    const caddy = read("src/app/caddy/page.tsx");
    assert(caddy.includes("<PushNotificationCard />"), "caddy card still default");
    const subRoute = read("src/app/api/push/subscription/route.ts");
    assert(subRoute.includes("resolvePushSubscriptionUserId"), "subscription API reuses resolve");
    assert(subRoute.includes("upsertPushSubscriptionForUser"), "upsert reused");
    assert(subRoute.includes("deletePushSubscriptionForUser"), "delete reused");
  }

  section("admin surface copy");
  {
    assert(ADMIN_PUSH_UI_ENABLE === "이 기기 알림 받기", "enable copy");
    assert(ADMIN_PUSH_UI_DISABLE === "이 기기 알림 해제", "disable copy");
    assert(ADMIN_PUSH_UI_DISABLE_HINT.includes("모두 해제"), "device-level hint");
    assert(adminPushSurfaceStatus("on").includes(ADMIN_PUSH_UI_REGISTERED), "registered");
    assert(adminPushSurfaceStatus("off").includes(ADMIN_PUSH_UI_UNREGISTERED), "unregistered");
    assert(adminPushSurfaceStatus("blocked").includes(ADMIN_PUSH_UI_DENIED), "denied");
  }

  const tag = `admpush_${Date.now()}`;
  const hash = await bcrypt.hash("admpush-v1-pw", 4);
  const userIds: number[] = [];
  const subIds: number[] = [];

  try {
    const dbAdmin = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hash,
        role: "ADMIN",
        sessionVersion: 0,
      },
    });
    userIds.push(dbAdmin.id);
    const dbStaff = await prisma.user.create({
      data: {
        username: `${tag}_staff`,
        password: hash,
        role: "admin",
        sessionVersion: 0,
      },
    });
    userIds.push(dbStaff.id);
    const dbCaddy = await prisma.user.create({
      data: {
        username: `${tag}_caddy`,
        password: hash,
        role: "caddy",
        sessionVersion: 0,
      },
    });
    userIds.push(dbCaddy.id);
    const dbLeader = await prisma.user.create({
      data: {
        username: `${tag}_leader`,
        password: hash,
        role: "leader",
        sessionVersion: 0,
      },
    });
    userIds.push(dbLeader.id);
    const dbCaddyNamedAdmin = await prisma.user.create({
      data: {
        username: `${tag}_notadmin`,
        password: hash,
        role: "caddy",
        sessionVersion: 0,
      },
    });
    userIds.push(dbCaddyNamedAdmin.id);

    section("resolve env-only admin");
    {
      const hit = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: dbAdmin.username,
        role: "admin",
      });
      assert(hit === dbAdmin.id, "env admin exact username → DB admin id");
      assert(hit !== 1 || dbAdmin.id === 1, "resolved id is matched row, not forced 1");

      const wrong = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: `${tag}_missing`,
        role: "admin",
      });
      assert(wrong === null, "wrong username → null");

      const nonAdmin = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: dbCaddyNamedAdmin.username,
        role: "admin",
      });
      assert(nonAdmin === null, "non-admin DB User → null");

      const envCaddy = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: dbCaddy.username,
        role: "caddy",
      });
      assert(envCaddy === null, "env caddy no fallback");
      assert(
        isEnvOnlyNonAdmin({ userId: null, role: "caddy" }) === true,
        "env caddy isEnvOnlyNonAdmin"
      );

      const envLeader = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: dbLeader.username,
        role: "leader",
      });
      assert(envLeader === null, "env leader no fallback");

      const dbSession = await resolvePushSubscriptionUserId(prisma, {
        userId: dbStaff.id,
        username: "ignored",
        role: "admin",
      });
      assert(dbSession === dbStaff.id, "DB admin session uses userId");

      const caddySession = await resolvePushSubscriptionUserId(prisma, {
        userId: dbCaddy.id,
        username: dbCaddy.username,
        role: "caddy",
      });
      assert(caddySession === dbCaddy.id, "DB caddy still uses own userId");
    }

    section("HTTP env-only admin register");
    {
      const envAdminCookie = await cookieFor({
        id: null,
        username: dbAdmin.username,
        role: "admin",
        sessionVersion: 0,
      });
      const getOk = await jsonReq("GET", envAdminCookie);
      assert(getOk.status === 200, "env admin GET 200 after resolve");
      const getBody = await getOk.json();
      assert(getBody.configured === true, "GET configured");
      assert(getBody.subscriptionExists === false, "GET not registered yet");

      const ep = `https://fcm.googleapis.com/fcm/send/${tag}-admin-1`;
      const created = await jsonReq("POST", envAdminCookie, validBody(ep));
      assert(created.status === 200, "env admin POST 200");
      const row = await prisma.pushSubscription.findFirst({ where: { endpoint: ep } });
      assert(row?.userId === dbAdmin.id, "saved under resolved admin User.id");
      if (row) subIds.push(row.id);

      const again = await jsonReq("POST", envAdminCookie, validBody(ep));
      assert(again.status === 200, "re-POST 200");
      const rows = await prisma.pushSubscription.findMany({ where: { endpoint: ep } });
      assert(rows.length === 1, "same endpoint no duplicate row");
      assert(rows[0]?.userId === dbAdmin.id, "still admin owner");

      const caddyCookie = await cookieFor({
        id: dbCaddy.id,
        username: dbCaddy.username,
        role: "caddy",
        sessionVersion: 0,
      });
      const steal = await jsonReq("POST", caddyCookie, validBody(ep));
      assert(steal.status === 200, "caddy same endpoint 200");
      const stillAdmin = await prisma.pushSubscription.findMany({ where: { endpoint: ep } });
      assert(stillAdmin.length === 2, "admin + caddy mappings coexist");
      assert(stillAdmin.some((r) => r.userId === dbAdmin.id), "admin row not stolen");
      assert(stillAdmin.some((r) => r.userId === dbCaddy.id), "caddy mapping created");
      for (const row of stillAdmin) subIds.push(row.id);

      const caddyEp = `https://fcm.googleapis.com/fcm/send/${tag}-caddy-keep`;
      const caddyPost = await jsonReq("POST", caddyCookie, validBody(caddyEp));
      assert(caddyPost.status === 200, "caddy register still works");
      const caddyRow = await prisma.pushSubscription.findFirst({ where: { endpoint: caddyEp } });
      assert(caddyRow?.userId === dbCaddy.id, "caddy row owned by caddy");
      if (caddyRow) subIds.push(caddyRow.id);

      const del = await jsonReq("DELETE", envAdminCookie, { endpoint: ep });
      assert(del.status === 200, "admin unsubscribe DELETE 200");
      const gone = await prisma.pushSubscription.findFirst({ where: { endpoint: ep } });
      assert(gone == null, "admin endpoint deleted");
      const stillCaddy = await prisma.pushSubscription.findFirst({ where: { endpoint: caddyEp } });
      assert(stillCaddy?.userId === dbCaddy.id, "caddy subscription untouched");
    }

    section("HTTP fail-closed");
    {
      const badName = await cookieFor({
        id: null,
        username: `${tag}_missing`,
        role: "admin",
        sessionVersion: 0,
      });
      const badGet = await jsonReq("GET", badName);
      assert(badGet.status === 403, "wrong username GET 403");
      const badPost = await jsonReq("POST", badName, validBody(`https://fcm.googleapis.com/fcm/send/${tag}-bad`));
      assert(badPost.status === 403, "wrong username POST 403");

      const nonAdminCookie = await cookieFor({
        id: null,
        username: dbCaddyNamedAdmin.username,
        role: "admin",
        sessionVersion: 0,
      });
      const nonAdminPost = await jsonReq(
        "POST",
        nonAdminCookie,
        validBody(`https://fcm.googleapis.com/fcm/send/${tag}-nonadmin`)
      );
      assert(nonAdminPost.status === 403, "non-admin DB User POST 403");

      const envCaddyCookie = await cookieFor({
        id: null,
        username: dbCaddy.username,
        role: "caddy",
        sessionVersion: 0,
      });
      const envCaddyGet = await jsonReq("GET", envCaddyCookie);
      assert(envCaddyGet.status === 400, "env caddy GET 400 unsupported");
      const envCaddyBody = await envCaddyGet.json();
      assert(envCaddyBody.error === "unsupported", "env caddy unsupported");

      const envLeaderCookie = await cookieFor({
        id: null,
        username: dbLeader.username,
        role: "leader",
        sessionVersion: 0,
      });
      const envLeaderGet = await jsonReq("GET", envLeaderCookie);
      assert(envLeaderGet.status === 400, "env leader GET 400 unsupported");

      const unauth = await jsonReq("GET", undefined);
      assert(unauth.status === 401, "unauth GET 401");
    }

    section("parse still ignores client userId");
    {
      const parsed = parsePushSubscriptionInput({
        ...validBody(`https://fcm.googleapis.com/fcm/send/${tag}-parse`),
        userId: 1,
      });
      assert(!("userId" in parsed), "parsed input has no userId");
    }
  } finally {
    if (subIds.length) {
      await prisma.pushSubscription.deleteMany({ where: { id: { in: subIds } } });
    }
    await prisma.pushSubscription.deleteMany({
      where: { user: { username: { startsWith: tag } } },
    });
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevPub === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
