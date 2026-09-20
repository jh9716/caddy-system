/**
 * Same-device multi-user PushSubscription V1. local caddy_local only.
 * Mock provider: no external push network.
 * 실행: npm run test:push-same-device-unit
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
import { POST as POST_LOGOUT } from "../src/app/api/logout/route";
import {
  isEnvOnlyNonAdmin,
  resolvePushSubscriptionUserId,
} from "../src/lib/adminPushUser";
import {
  PUSH_ENDPOINT_HEADER,
  parsePushSubscriptionInput,
} from "../src/lib/pushSubscriptionStore";
import { deliverWebPushMappings } from "../src/lib/pushDelivery";
import { readWebPushSendCredentials } from "../src/lib/pushVapid";
import {
  sendCourseReportPush,
} from "../src/lib/courseReportPush";
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

function fakePriv(): string {
  return b64url(Buffer.alloc(32, 7));
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

function jsonHasSecrets(body: unknown): boolean {
  const s = JSON.stringify(body);
  return /p256dh/i.test(s) || /"auth"/i.test(s) || /endpoint/i.test(s);
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
  const prevSub = process.env.WEB_PUSH_SUBJECT;
  process.env.SESSION_SECRET = "push-same-device-unit-secret-32ch!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = fakePriv();
  process.env.WEB_PUSH_SUBJECT = "https://www.verthill.kr";

  section("source / schema");
  {
    const schema = read("prisma/schema.prisma");
    const model = schema.split("model PushSubscription")[1]?.split("}")[0] || "";
    assert(!model.includes("endpoint String @unique"), "endpoint not @unique");
    assert(schema.includes("@@unique([userId, endpoint])"), "compound unique");
    assert(schema.includes("@@index([endpoint])"), "endpoint index");
    const sql = read(
      "prisma/migrations/20260920013000_push_subscription_user_endpoint_unique/migration.sql"
    );
    assert(sql.includes('DROP INDEX IF EXISTS "PushSubscription_endpoint_key"'), "drop old unique");
    assert(sql.includes("PushSubscription_userId_endpoint_key"), "new unique");
    assert(sql.includes("PushSubscription_endpoint_idx"), "endpoint idx");
    assert(!/^\s*(INSERT|UPDATE|DELETE)\b/im.test(sql), "migration no DML");
    assert(!sql.includes("DROP TABLE"), "no DROP TABLE");
    assert(!sql.includes("DROP COLUMN"), "no DROP COLUMN");
    const store = read("src/lib/pushSubscriptionStore.ts");
    assert(store.includes("userId_endpoint"), "upsert compound where");
    assert(!/update:\s*\{[^}]*userId/.test(store), "update does not reassign userId");
    const delivery = read("src/lib/pushDelivery.ts");
    assert(delivery.includes("groupMappingsByEndpoint") || delivery.includes("groups.set"), "endpoint groups");
    assert(!/console\.(log|info|debug|error)\([^)]*endpoint/.test(delivery), "no endpoint logs");
    const card = read("src/components/PushNotificationCard.tsx");
    assert(card.includes("x-push-endpoint"), "GET sends current endpoint header");
    assert(card.includes("serverRegistered"), "surface uses server registered");
    assert(!card.includes("WEB_PUSH_VAPID_PRIVATE_KEY"), "card no private key");
    const route = read("src/app/api/push/subscription/route.ts");
    assert(route.includes("PUSH_ENDPOINT_HEADER"), "GET header");
    assert(route.includes("userHasEnabledPushSubscriptionForEndpoint"), "GET per user+endpoint");
    const logout = read("src/app/api/logout/route.ts");
    assert(!logout.toLowerCase().includes("pushsubscription"), "logout no mapping delete");
    for (const rel of [
      "src/lib/webPushTestSend.ts",
      "src/lib/boardPush.ts",
      "src/lib/noticePush.ts",
      "src/lib/courseReportPush.ts",
    ]) {
      const src = read(rel);
      assert(src.includes("deliverWebPushMappings"), `${rel} uses helper`);
      assert(!src.includes("delete({ where: { id: sub.id } })"), `${rel} no per-id gone delete`);
    }
  }

  const tag = `sdev_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const userIds: number[] = [];
  const reportIds: number[] = [];

  try {
    const caddyRow = await prisma.caddy.create({
      data: { name: `${tag}_caddy`, team: "1조", employmentStatus: "ACTIVE" },
    });
    const userA = await prisma.user.create({
      data: {
        username: `${tag}_caddy`,
        password: hash,
        role: "caddy",
        caddyId: caddyRow.id,
        sessionVersion: 0,
      },
    });
    userIds.push(userA.id);
    const userB = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hash,
        role: "admin",
        sessionVersion: 0,
      },
    });
    userIds.push(userB.id);
    const userC = await prisma.user.create({
      data: {
        username: `${tag}_other`,
        password: hash,
        role: "caddy",
        sessionVersion: 0,
      },
    });
    userIds.push(userC.id);

    const cookieA = await cookieFor({
      id: userA.id,
      username: userA.username,
      role: "caddy",
      sessionVersion: 0,
    });
    const cookieB = await cookieFor({
      id: userB.id,
      username: userB.username,
      role: "admin",
      sessionVersion: 0,
    });
    const cookieC = await cookieFor({
      id: userC.id,
      username: userC.username,
      role: "caddy",
      sessionVersion: 0,
    });
    const envAdminCookie = await cookieFor({
      id: null,
      username: userB.username,
      role: "admin",
      sessionVersion: 0,
    });

    const X = `https://fcm.googleapis.com/fcm/send/${tag}-X`;
    const Y = `https://fcm.googleapis.com/fcm/send/${tag}-Y`;

    section("1-6 register + GET");
    {
      const aPost = await jsonReq("POST", cookieA, validBody(X));
      assert(aPost.status === 200, "1 A/X POST 200");
      const afterA = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(afterA.length === 1, "1 A/X row 1");
      assert(afterA[0]?.userId === userA.id, "1 owned by caddy A");

      const bPost = await jsonReq("POST", cookieB, validBody(X));
      assert(bPost.status === 200, "2 B/X POST 200");
      const afterB = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(afterB.length === 2, "2 A/X + B/X row 2");
      const aRow = afterB.find((r) => r.userId === userA.id);
      const bRow = afterB.find((r) => r.userId === userB.id);
      assert(aRow != null && aRow.userId === userA.id, "3 A/X userId kept");
      assert(bRow != null && bRow.userId === userB.id, "4 B/X separate userId");

      const aGet = await jsonReq("GET", cookieA, undefined, { [PUSH_ENDPOINT_HEADER]: X });
      const aGetBody = await aGet.json();
      assert(aGet.status === 200 && aGetBody.subscriptionExists === true, "5 A GET registered");
      assert(!jsonHasSecrets(aGetBody) || !("endpoint" in aGetBody), "5 GET no raw endpoint");
      assert(aGetBody.endpoint == null, "5 GET endpoint omitted");

      const bGet = await jsonReq("GET", cookieB, undefined, { [PUSH_ENDPOINT_HEADER]: X });
      const bGetBody = await bGet.json();
      assert(bGet.status === 200 && bGetBody.subscriptionExists === true, "6 B GET registered");
    }

    section("7-9 delivery dedupe");
    {
      const yRow = await prisma.pushSubscription.create({
        data: {
          userId: userC.id,
          endpoint: Y,
          p256dh: fakeP256(),
          auth: fakeAuth(),
          enabled: true,
        },
      });
      const report = await prisma.courseReport.create({
        data: {
          authorUserId: userA.id,
          authorDisplayName: "캐디A",
          title: `${tag} STATUS`,
          body: "본문",
          course: "SKY",
          category: "OTHER",
        },
      });
      reportIds.push(report.id);
      let statusHits = 0;
      const status = await sendCourseReportPush(
        prisma,
        { kind: "STATUS", reportId: report.id, status: "CHECKING" },
        {
          sendFn: async (sub) => {
            if (sub.endpoint === X) statusHits += 1;
          },
        }
      );
      assert(status.ok && statusHits === 1, "7 A STATUS network 1");
      assert(status.sent === 1 && status.deliveries === 1, "7 STATUS deliveries 1");
      assert(status.recipients === 1 && status.subscriptions === 1, "7 STATUS recipients 1 mapping 1");

      const reportNew = await prisma.courseReport.create({
        data: {
          authorUserId: userA.id,
          authorDisplayName: "캐디A",
          title: `${tag} NEW`,
          body: "본문",
          course: "SKY",
          category: "SAFETY",
        },
      });
      reportIds.push(reportNew.id);
      let newHits = 0;
      const created = await sendCourseReportPush(
        prisma,
        { kind: "NEW", reportId: reportNew.id },
        {
          sendFn: async (sub) => {
            if (sub.endpoint === X) newHits += 1;
          },
        }
      );
      assert(created.ok && newHits === 1, "8 B NEW network 1");
      assert(created.deliveries >= 1 && created.sent >= 1, "8 NEW at least 1 delivery");

      const mappings = await prisma.pushSubscription.findMany({
        where: { endpoint: X },
        select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
      });
      const creds = readWebPushSendCredentials();
      assert(creds != null, "send creds present");
      let sharedHits = 0;
      const shared = await deliverWebPushMappings(
        prisma,
        mappings,
        { title: "t", body: "b", url: "/caddy" },
        {
          sendFn: async () => { sharedHits += 1; },
          credentials: creds!,
          concurrency: 4,
        }
      );
      assert(sharedHits === 1, "9 A+B same event network 1");
      assert(shared.deliveries === 1 && shared.sent === 1, "9 deliveries 1 sent 1");
      const afterShared = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(
        afterShared.length === 2 && afterShared.every((r) => r.lastSuccessAt != null),
        "9 both selected mappings lastSuccessAt"
      );
      const yStill = await prisma.pushSubscription.findUnique({ where: { id: yRow.id } });
      assert(yStill != null, "13 Y untouched after success");
    }

    section("10 re-POST A/X no duplicate");
    {
      const again = await jsonReq("POST", cookieA, validBody(X));
      assert(again.status === 200, "10 A re-POST 200");
      const rows = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(rows.length === 2, "10 still 2 rows");
      assert(rows.filter((r) => r.userId === userA.id).length === 1, "10 no A duplicate");
    }

    section("14 foreign DELETE blocked");
    {
      const blocked = await jsonReq("DELETE", cookieC, { endpoint: X });
      assert(blocked.status === 403, "14 C DELETE X 403");
      const still = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(still.length === 2, "14 A/B mappings kept");
    }

    section("15 logout keeps mappings");
    {
      const logoutRes = await POST_LOGOUT(
        new NextRequest("https://www.verthill.kr/api/logout", {
          method: "POST",
          headers: { cookie: cookieA },
        })
      );
      assert(logoutRes.status === 200, "15 logout 200");
      const still = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(still.length === 2, "15 logout does not delete mappings");
    }

    section("16-17 env admin exact-match / no caddy fallback");
    {
      const envId = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: userB.username,
        role: "admin",
      });
      assert(envId === userB.id, "16 env admin exact username");
      const envPost = await jsonReq("POST", envAdminCookie, validBody(X));
      assert(envPost.status === 200, "16 env admin POST still upserts B/X");
      const bRows = await prisma.pushSubscription.findMany({
        where: { userId: userB.id, endpoint: X },
      });
      assert(bRows.length === 1, "16 env admin no extra B row");
      const envCaddy = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: userA.username,
        role: "caddy",
      });
      assert(envCaddy === null, "17 env caddy no fallback");
      assert(
        isEnvOnlyNonAdmin({ userId: null, role: "caddy" }) === true,
        "17 env caddy unsupported"
      );
      const envLeader = await resolvePushSubscriptionUserId(prisma, {
        userId: null,
        username: userA.username,
        role: "leader",
      });
      assert(envLeader === null, "17 env leader no fallback");
    }

    section("12 gone deletes all X mappings");
    {
      const creds = readWebPushSendCredentials();
      const mappings = await prisma.pushSubscription.findMany({
        where: { endpoint: X },
        select: { id: true, userId: true, endpoint: true, p256dh: true, auth: true },
      });
      assert(mappings.length === 2, "gone setup 2 X rows");
      const gone = await deliverWebPushMappings(
        prisma,
        mappings.slice(0, 1),
        { title: "t", body: "b", url: "/caddy" },
        {
          sendFn: async () => {
            const err = new Error("gone") as Error & { statusCode: number };
            err.statusCode = 410;
            throw err;
          },
          credentials: creds!,
          concurrency: 1,
        }
      );
      assert(gone.removedStale === 1 && gone.deliveries === 1, "12 gone 1 delivery");
      const xRows = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(xRows.length === 0, "12 A/B X mappings deleted");
      const yRows = await prisma.pushSubscription.findMany({ where: { endpoint: Y } });
      assert(yRows.length === 1, "13 Y untouched after gone");
    }

    section("11 device-level unsubscribe");
    {
      await jsonReq("POST", cookieA, validBody(X));
      await jsonReq("POST", cookieB, validBody(X));
      assert(
        (await prisma.pushSubscription.count({ where: { endpoint: X } })) === 2,
        "11 setup A/B"
      );
      const del = await jsonReq("DELETE", cookieB, { endpoint: X });
      assert(del.status === 200, "11 B DELETE 200");
      const delBody = await del.json();
      assert(delBody.subscriptionExists === false, "11 B status off");
      const xRows = await prisma.pushSubscription.findMany({ where: { endpoint: X } });
      assert(xRows.length === 0, "11 A and B X rows deleted");
      const yRows = await prisma.pushSubscription.findMany({ where: { endpoint: Y } });
      assert(yRows.length === 1, "13 Y untouched after device unsubscribe");
    }

    section("parsed input ignores client userId");
    {
      const parsed = parsePushSubscriptionInput({
        ...validBody(`https://fcm.googleapis.com/fcm/send/${tag}-parse`),
        userId: 1,
      });
      assert(!("userId" in parsed), "parsed input has no userId");
    }
  } finally {
    await prisma.audit.deleteMany({
      where: { entityId: { in: reportIds.filter((n) => Number.isInteger(n)) } },
    });
    if (reportIds.length) {
      await prisma.courseReport.deleteMany({ where: { id: { in: reportIds } } });
    }
    await prisma.pushSubscription.deleteMany({
      where: { userId: { in: userIds } },
    });
    if (userIds.length) {
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    await prisma.caddy.deleteMany({ where: { name: { startsWith: tag } } });
    await prisma.$disconnect();
    if (prevSecret === undefined) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevPub === undefined) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv === undefined) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
    if (prevSub === undefined) delete process.env.WEB_PUSH_SUBJECT;
    else process.env.WEB_PUSH_SUBJECT = prevSub;
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
