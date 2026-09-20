/**
 * Push Subscription V1 — local caddy_local only.
 * 실행: npm run test:push-subscription-unit
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
import {
  decodeUrlSafeBase64,
  isUncompressedP256PublicKey,
  isWebPushConfigured,
  readVapidPublicKey,
  vapidClientConfig,
} from "../src/lib/pushVapid";
import {
  parsePushSubscriptionInput,
  upsertPushSubscriptionForUser,
  deletePushSubscriptionForUser,
} from "../src/lib/pushSubscriptionStore";
import {
  PUSH_UI_IOS_ADD_TO_HOME,
  PUSH_UI_PREPARING,
  resolvePushNotificationSurface,
  shouldRequestPermissionOnEnable,
} from "../src/lib/pushNotificationUi";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";

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
  id: number;
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

async function envCookie() {
  return `${SESSION_COOKIE_NAME}=${await signSessionClaims(
    buildSessionClaims({
      userId: null,
      username: "env-admin",
      role: "admin",
      sessionVersion: 0,
    })
  )}`;
}

async function jsonReq(
  method: string,
  cookie: string | undefined,
  body?: unknown,
  extraHeaders?: Record<string, string>
) {
  const { GET, POST, DELETE } = await import(
    "../src/app/api/push/subscription/route"
  );
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
  process.env.SESSION_SECRET = "push-sub-unit-secret-32chars-ok!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;

  section("A. schema / migration additive");
  {
    const schema = read("prisma/schema.prisma");
    const sql = read("prisma/migrations/20260917200000_push_subscription/migration.sql");
    assert(schema.includes("model PushSubscription"), "schema model");
    assert(schema.includes("pushSubscriptions PushSubscription[]"), "User relation");
    const model = schema.split("model PushSubscription")[1]?.split("}")[0] || "";
    assert(!/\bcaddyId\b/.test(model), "PushSubscription has no caddyId snapshot");
    assert(!model.includes("endpoint String @unique"), "endpoint not unique alone");
    assert(schema.includes("@@unique([userId, endpoint])"), "unique userId+endpoint");
    assert(schema.includes("@@index([endpoint])"), "endpoint non-unique index");
    assert(schema.includes("@@index([userId])"), "userId index");
    assert(sql.includes('CREATE TABLE "PushSubscription"'), "CREATE TABLE");
    assert(sql.includes("PushSubscription_userId_fkey"), "FK userId");
    assert(sql.includes("PushSubscription_endpoint_key"), "historical unique endpoint");
    assert(sql.includes("PushSubscription_userId_idx"), "userId index");
    assert(!sql.includes("DROP TABLE"), "no DROP TABLE");
    assert(!sql.includes("DROP COLUMN"), "no DROP COLUMN");
    assert(!sql.includes("ALTER TABLE \"User\" DROP"), "no User DROP");
    const nextSql = read(
      "prisma/migrations/20260920013000_push_subscription_user_endpoint_unique/migration.sql"
    );
    assert(nextSql.includes('DROP INDEX IF EXISTS "PushSubscription_endpoint_key"'), "drops endpoint unique");
    assert(nextSql.includes("PushSubscription_userId_endpoint_key"), "compound unique");
    assert(nextSql.includes("PushSubscription_endpoint_idx"), "endpoint index");
    assert(!/^\s*(INSERT|UPDATE|DELETE)\b/im.test(nextSql), "no DML");
    assert(!nextSql.includes("DROP TABLE"), "new migration no DROP TABLE");
    assert(!nextSql.includes("DROP COLUMN"), "new migration no DROP COLUMN");
    const pkg = read("package.json");
    assert(pkg.includes("web-push"), "web-push is a server dependency for send");
  }

  section("A2. no send / privacy in source");
  {
    const files = [
      "src/app/api/push/subscription/route.ts",
      "src/lib/pushVapid.ts",
      "src/lib/pushSubscriptionStore.ts",
      "src/lib/pushNotificationUi.ts",
      "src/components/PushNotificationCard.tsx",
      "public/sw.js",
    ];
    for (const rel of files) {
      const src = read(rel);
      assert(!src.includes("sendNotification"), `${rel} no sendNotification`);
      assert(!/from ["']web-push["']/.test(src), `${rel} no web-push import`);
      assert(!src.includes("firebase"), `${rel} no firebase`);
      assert(!src.includes("FCM"), `${rel} no FCM`);
    }
    const sw = read("public/sw.js");
    assert(/addEventListener\(\s*["']push["']/.test(sw), "sw has push listener");
    assert(!/event\.respondWith/.test(sw), "sw still no respondWith");
    const card = read("src/components/PushNotificationCard.tsx");
    assert(card.includes("requestPermission"), "permission only in card click path");
    assert(!read("src/app/caddy/page.tsx").includes("requestPermission"), "page load does not request permission");
    const vapid = read("src/lib/pushVapid.ts");
    assert(vapid.includes("WEB_PUSH_VAPID_PUBLIC_KEY"), "public env name");
    assert(vapid.includes("WEB_PUSH_VAPID_PRIVATE_KEY"), "private env name documented");
    assert(vapid.includes("WEB_PUSH_SUBJECT"), "subject env name");
    assert(!read("src/components/PushNotificationCard.tsx").includes("WEB_PUSH_VAPID_PRIVATE_KEY"), "private key env not in client card");
    const logout = read("src/app/api/logout/route.ts");
    assert(!logout.toLowerCase().includes("pushsubscription"), "logout does not delete subscription");
  }

  section("E. UI surfaces");
  {
    assert(
      resolvePushNotificationSurface({
        configured: false,
        standalone: true,
        ios: false,
        notificationSupported: true,
        pushManagerSupported: true,
        permission: "granted",
        localSubscription: true,
        serverRegistered: false,
      }) === "preparing",
      "VAPID missing → preparing"
    );
    assert(
      resolvePushNotificationSurface({
        configured: true,
        standalone: false,
        ios: true,
        notificationSupported: true,
        pushManagerSupported: true,
        permission: "default",
        localSubscription: false,
        serverRegistered: false,
      }) === "ios-add-to-home",
      "iOS Safari tab → add to home"
    );
    assert(
      resolvePushNotificationSurface({
        configured: true,
        standalone: true,
        ios: true,
        notificationSupported: true,
        pushManagerSupported: true,
        permission: "granted",
        localSubscription: true,
        serverRegistered: true,
      }) === "on",
      "iOS PWA standalone + granted + server → on"
    );
    assert(
      resolvePushNotificationSurface({
        configured: true,
        standalone: true,
        ios: true,
        notificationSupported: true,
        pushManagerSupported: true,
        permission: "granted",
        localSubscription: true,
        serverRegistered: false,
      }) === "off",
      "local sub without this User mapping → off"
    );
    assert(
      resolvePushNotificationSurface({
        configured: true,
        standalone: false,
        ios: false,
        notificationSupported: true,
        pushManagerSupported: true,
        permission: "default",
        localSubscription: false,
        serverRegistered: false,
      }) === "off",
      "Android/browser can enable"
    );
    assert(
      resolvePushNotificationSurface({
        configured: true,
        standalone: false,
        ios: false,
        notificationSupported: true,
        pushManagerSupported: true,
        permission: "denied",
        localSubscription: false,
        serverRegistered: false,
      }) === "blocked",
      "denied → blocked"
    );
    assert(
      resolvePushNotificationSurface({
        configured: true,
        standalone: false,
        ios: false,
        notificationSupported: false,
        pushManagerSupported: false,
        permission: "unsupported",
        localSubscription: false,
        serverRegistered: false,
      }) === "unsupported",
      "no PushManager → unsupported"
    );
    assert(
      shouldRequestPermissionOnEnable("off") === true,
      "permission request only from off/enable"
    );
    assert(
      shouldRequestPermissionOnEnable("preparing") === false,
      "preparing does not request permission"
    );
    assert(PUSH_UI_PREPARING.includes("준비"), "preparing copy");
    assert(PUSH_UI_IOS_ADD_TO_HOME.includes("홈 화면"), "iOS copy");
  }

  section("VAPID public only");
  {
    assert(isWebPushConfigured() === true, "configured when public key set");
    const cfg = vapidClientConfig();
    assert(cfg.configured && cfg.vapidPublicKey === process.env.WEB_PUSH_VAPID_PUBLIC_KEY, "returns public key");
    assert(isUncompressedP256PublicKey(decodeUrlSafeBase64(cfg.vapidPublicKey || "")), "public key shape");
    const snap = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    assert(isWebPushConfigured() === false, "missing public → not configured");
    assert(readVapidPublicKey() == null, "no public key");
    process.env.WEB_PUSH_VAPID_PUBLIC_KEY = snap;
  }

  const tag = `pushv1_${Date.now()}`;
  const hash = await bcrypt.hash("push-v1-pw", 4);
  try {
    const cActive = await prisma.caddy.create({
      data: { name: `${tag}_a`, team: tag.slice(0, 8), teamOrder: 1, employmentStatus: "ACTIVE" },
    });
    const cRet = await prisma.caddy.create({
      data: { name: `${tag}_r`, team: tag.slice(0, 8), teamOrder: 2, employmentStatus: "RETIRED" },
    });
    const uCaddy = await prisma.user.create({
      data: {
        username: `${tag}_caddy`,
        password: hash,
        role: "caddy",
        caddyId: cActive.id,
        sessionVersion: 0,
      },
    });
    const uOther = await prisma.user.create({
      data: {
        username: `${tag}_other`,
        password: hash,
        role: "caddy",
        sessionVersion: 0,
        kakaoUserId: `k_${tag}`,
      },
    });
    const uRetired = await prisma.user.create({
      data: {
        username: `${tag}_retired`,
        password: hash,
        role: "caddy",
        caddyId: cRet.id,
        sessionVersion: 0,
      },
    });
    const uUnlinked = await prisma.user.create({
      data: {
        username: `${tag}_unlinked`,
        password: hash,
        role: "caddy",
        caddyId: null,
        kakaoUserId: `k2_${tag}`,
        sessionVersion: 0,
      },
    });

    section("B. auth");
    {
      const unauth = await jsonReq("GET", undefined);
      assert(unauth.status === 401, "unauth GET 401");
      const unauthBody = await unauth.json();
      assert(unauthBody.role === undefined && unauthBody.error === "unauthorized", "unauth error unauthorized");

      const envRes = await jsonReq("GET", await envCookie());
      assert(envRes.status === 403, "env admin without matching User forbidden");
      const envBody = await envRes.json();
      assert(envBody.error === "forbidden", "env mismatch forbidden");

      const ok = await jsonReq("GET", await cookieFor({ ...uCaddy, role: "caddy" }));
      assert(ok.status === 200, "valid DB user GET 200");
      const okBody = await ok.json();
      assert(okBody.configured === true, "GET configured");
      assert(typeof okBody.vapidPublicKey === "string", "GET has public key");
      assert(!JSON.stringify(okBody).includes("https://"), "GET has no endpoint URL");
      assert(okBody.p256dh == null && okBody.auth == null && okBody.endpoint == null, "GET no keys");
      assert(
        Object.keys(okBody).every((k) =>
          ["configured", "vapidPublicKey", "subscriptionExists", "enabled"].includes(k)
        ),
        "GET status keys only"
      );

      await prisma.user.update({
        where: { id: uCaddy.id },
        data: { sessionVersion: { increment: 1 } },
      });
      const stale = await jsonReq("POST", await cookieFor({ ...uCaddy, role: "caddy", sessionVersion: 0 }), validBody("https://push.example.com/stale"));
      assert(stale.status === 401, "stale sv POST 401");
      await prisma.user.update({
        where: { id: uCaddy.id },
        data: { sessionVersion: 0 },
      });

      const ret = await jsonReq(
        "POST",
        await cookieFor({ ...uRetired, role: "caddy" }),
        validBody("https://push.example.com/retired")
      );
      assert(ret.status === 401, "RETIRED caddy POST 401");
    }

    section("C. subscription upsert");
    {
      const ep = `https://fcm.googleapis.com/fcm/send/${tag}-dev-1`;
      const cookie = await cookieFor({ ...uCaddy, role: "caddy" });
      const created = await jsonReq("POST", cookie, {
        ...validBody(ep),
        userId: uOther.id,
      });
      assert(created.status === 200, "POST 200");
      const createdBody = await created.json();
      assert(createdBody.subscriptionExists === true, "POST exists");
      assert(createdBody.endpoint == null, "POST response no endpoint");
      assert(createdBody.p256dh == null, "POST response no p256dh");

      const again = await jsonReq("POST", cookie, validBody(ep));
      assert(again.status === 200, "re-POST 200");
      const rows = await prisma.pushSubscription.findMany({ where: { endpoint: ep } });
      assert(rows.length === 1, "same user+endpoint → 1 row");
      assert(rows[0]?.userId === uCaddy.id, "owned by current user");

      const getThis = await jsonReq("GET", cookie, undefined, { "x-push-endpoint": ep });
      const getThisBody = await getThis.json();
      assert(getThisBody.subscriptionExists === true, "GET this User+endpoint registered");
      const getNoEp = await jsonReq("GET", cookie);
      const getNoEpBody = await getNoEp.json();
      assert(getNoEpBody.subscriptionExists === false, "GET without endpoint not this-device registered");

      const otherCookie = await cookieFor({ ...uOther, role: "caddy" });
      const otherGet = await jsonReq("GET", otherCookie, undefined, { "x-push-endpoint": ep });
      const otherGetBody = await otherGet.json();
      assert(otherGetBody.subscriptionExists === false, "other User same endpoint not registered");
      const reassign = await jsonReq("POST", otherCookie, validBody(ep));
      assert(reassign.status === 200, "other user POST 200");
      const after = await prisma.pushSubscription.findMany({ where: { endpoint: ep } });
      assert(after.length === 2, "same endpoint two User rows");
      const owners = new Set(after.map((r) => r.userId));
      assert(owners.has(uCaddy.id) && owners.has(uOther.id), "A/X and B/X coexist");
      assert(after.find((r) => r.userId === uCaddy.id)?.userId === uCaddy.id, "A/X userId kept");

      const unlinkedCookie = await cookieFor({ ...uUnlinked, role: "caddy" });
      const unlinkedEp = `https://fcm.googleapis.com/fcm/send/${tag}-unlinked`;
      const unlinkedPost = await jsonReq("POST", unlinkedCookie, validBody(unlinkedEp));
      assert(unlinkedPost.status === 200, "caddyId=null User can register");

      const badHttp = await jsonReq("POST", cookie, validBody("http://insecure.example/push"));
      assert(badHttp.status === 400, "http endpoint rejected");
      const empty = await jsonReq("POST", cookie, { endpoint: ep, keys: { p256dh: "", auth: "" } });
      assert(empty.status === 400, "empty keys rejected");
      const missing = await jsonReq("POST", cookie, { endpoint: ep });
      assert(missing.status === 400, "missing keys rejected");
      const junk = await jsonReq("POST", cookie, { endpoint: "not-a-url", keys: { p256dh: "x", auth: "y" } });
      assert(junk.status === 400, "malformed rejected");
    }

    section("D. unsubscribe delete");
    {
      const ep = `https://fcm.googleapis.com/fcm/send/${tag}-del`;
      const cookie = await cookieFor({ ...uCaddy, role: "caddy" });
      await upsertPushSubscriptionForUser(prisma, uCaddy.id, {
        ...parsePushSubscriptionInput(validBody(ep)),
      });
      const del = await jsonReq("DELETE", cookie, { endpoint: ep });
      assert(del.status === 200, "DELETE 200");
      const delBody = await del.json();
      assert(delBody.subscriptionExists === false && delBody.enabled === false, "DELETE status off");
      const gone = await prisma.pushSubscription.findFirst({ where: { endpoint: ep } });
      assert(gone == null, "row deleted");
      const again = await jsonReq("POST", cookie, validBody(ep));
      assert(again.status === 200, "re-register after delete");
      const back = await prisma.pushSubscription.findFirst({ where: { endpoint: ep } });
      assert(back?.userId === uCaddy.id, "re-register row exists");
      await deletePushSubscriptionForUser(prisma, uCaddy.id, ep);
    }

    section("F. security / store helpers");
    {
      let threw = false;
      try {
        parsePushSubscriptionInput({ endpoint: "", keys: { p256dh: fakeP256(), auth: fakeAuth() } });
      } catch {
        threw = true;
      }
      assert(threw, "empty endpoint throws");
    }
  } finally {
    await prisma.pushSubscription.deleteMany({
      where: { user: { username: { startsWith: tag } } },
    });
    await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
    await prisma.caddy.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.$disconnect();
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevPub === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
