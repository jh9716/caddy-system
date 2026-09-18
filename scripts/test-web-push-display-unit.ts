/**
 * Web Push display + 1-person admin test send. local caddy_local only.
 * Mock provider: no external push network.
 * 실행: npm run test:web-push-display-unit
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
  parsePushPayload,
  resolveSameOriginUrl,
} from "../src/lib/webPushNotification";
import {
  TEST_PUSH_BODY,
  TEST_PUSH_CONFIRM,
  TEST_PUSH_TITLE,
  TEST_PUSH_URL,
} from "../src/lib/webPushTestConstants";
import { parseTestPushRequest, sendTestPushToUser } from "../src/lib/webPushTestSend";
import { PUSH_TEST_SEARCH_LIMIT, searchPushTestTargets } from "../src/lib/webPushTestTargets";
import { isGoneStatus } from "../src/lib/webPushSender";
import { GET as GET_TARGETS } from "../src/app/api/push/test-targets/route";
import { POST as POST_TEST } from "../src/app/api/push/test/route";

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

function secretKeys() {
  return ["endpoint", "p256dh", "auth", "WEB_PUSH_VAPID_PRIVATE_KEY", "privateKey"];
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

async function postTest(cookie: string | undefined, body: unknown) {
  const init: ConstructorParameters<typeof NextRequest>[1] = {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  };
  const req = new NextRequest("https://www.verthill.kr/api/push/test", init);
  return POST_TEST(req);
}

async function getTargets(cookie: string | undefined, q: string) {
  const url = `https://www.verthill.kr/api/push/test-targets?q=${encodeURIComponent(q)}`;
  const req = new NextRequest(url, {
    method: "GET",
    headers: cookie ? { cookie } : {},
  });
  return GET_TARGETS(req);
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevPub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const prevSub = process.env.WEB_PUSH_SUBJECT;
  process.env.SESSION_SECRET = "web-push-display-unit-secret-32chars!!";
  process.env.WEB_PUSH_VAPID_PUBLIC_KEY = fakeP256();
  process.env.WEB_PUSH_VAPID_PRIVATE_KEY = fakePriv();
  process.env.WEB_PUSH_SUBJECT = "https://www.verthill.kr";

  const tag = `wpd_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);

  section("source safety");
  {
    const sw = read("public/sw.js");
    assert(/addEventListener\(\s*["']push["']/.test(sw), "SW push listener");
    assert(/addEventListener\(\s*["']notificationclick["']/.test(sw), "SW notificationclick");
    assert(sw.includes("showNotification"), "showNotification");
    assert(!/event\.respondWith/.test(sw), "no respondWith");
    assert(!/caches\.open/.test(sw), "no caches.open");
    assert(sw.includes("skipWaiting"), "skipWaiting kept");
    assert(sw.includes("clients.claim"), "clients.claim kept");
    const page = read("src/app/manage/push-test/page.tsx");
    assert(!page.includes("web-push"), "UI no web-push");
    assert(!page.includes("WEB_PUSH_VAPID_PRIVATE_KEY"), "UI no private env");
    const sender = read("src/lib/webPushSender.ts");
    assert(/from ["']web-push["']/.test(sender), "sender uses web-push");
    assert(!sender.includes("console.log"), "sender no console.log");
    const vapid = read("src/lib/pushVapid.ts");
    assert(vapid.includes("readWebPushSendCredentials"), "send creds helper");
    assert(vapid.includes("Never includes private key"), "private never in client config");
    for (const rel of [
      "src/app/manage/push-test/page.tsx",
      "src/components/PushNotificationCard.tsx",
      "src/lib/webPushTestConstants.ts",
    ]) {
      const src = read(rel);
      assert(!/from ["']web-push["']/.test(src), `${rel} no web-push`);
    }
    const schema = read("prisma/schema.prisma");
    assert(!schema.includes("model NotificationSend"), "no NotificationSend table");
    const migrations = fs.readdirSync(path.join(process.cwd(), "prisma/migrations"));
    assert(
      !migrations.some((n) => /web.?push.?display|push.?test/i.test(n)),
      "no new migration folder"
    );
    assert(!read("src/lib/webPushSender.ts").includes("firebase"), "no firebase");
    assert(!read("src/lib/webPushSender.ts").includes("FCM"), "no FCM");
  }

  section("SW payload / same-origin");
  {
    const ok = parsePushPayload(
      JSON.stringify({ title: "VERTHILL", body: "hi", url: "/caddy", tag: "t1" })
    );
    assert(ok?.title === "VERTHILL", "parse title");
    assert(ok?.body === "hi", "parse body");
    assert(ok?.url === "/caddy", "parse url");
    assert(ok?.tag === "t1", "parse tag");
    assert(parsePushPayload("not-json") === null, "invalid JSON → null");
    assert(parsePushPayload("") === null, "empty JSON → null");
    const origin = "https://www.verthill.kr";
    assert(
      resolveSameOriginUrl("/caddy", origin) === "https://www.verthill.kr/caddy",
      "relative /caddy"
    );
    assert(
      resolveSameOriginUrl("https://www.verthill.kr/caddy", origin) ===
        "https://www.verthill.kr/caddy",
      "same origin absolute"
    );
    assert(resolveSameOriginUrl("https://evil.example/x", origin) === null, "external blocked");
    assert(resolveSameOriginUrl("//evil.example/x", origin) === null, "protocol-relative blocked");
    assert(resolveSameOriginUrl("javascript:alert(1)", origin) === null, "javascript blocked");
    const sw = read("public/sw.js");
    assert(sw.includes("resolveSameOriginUrl"), "sw has origin helper");
    assert(sw.includes("parsePushPayload"), "sw has JSON parse helper");
  }

  let caddyId = 0;
  let leaderId = 0;
  let retiredId = 0;
  let adminId = 0;
  let targetUserId = 0;
  let leaderUserId = 0;
  let retiredUserId = 0;
  let adminUserId = 0;
  let noSubUserId = 0;

  try {
    const caddy = await prisma.caddy.create({
      data: { name: `${tag}_김테스트`, team: "1조", employmentStatus: "ACTIVE" },
    });
    const leaderC = await prisma.caddy.create({
      data: { name: `${tag}_이조장`, team: "2조", employmentStatus: "ACTIVE" },
    });
    const retiredC = await prisma.caddy.create({
      data: { name: `${tag}_박퇴사`, team: "3조", employmentStatus: "RETIRED" },
    });
    caddyId = caddy.id;
    leaderId = leaderC.id;
    retiredId = retiredC.id;

    const uCaddy = await prisma.user.create({
      data: {
        username: `${tag}_caddy`,
        password: hash,
        role: "caddy",
        caddyId: caddy.id,
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
        username: `${tag}_retired`,
        password: hash,
        role: "caddy",
        caddyId: retiredC.id,
        sessionVersion: 0,
      },
    });
    const uAdmin = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hash,
        role: "admin",
        sessionVersion: 0,
      },
    });
    const uNoSub = await prisma.user.create({
      data: {
        username: `${tag}_nosub`,
        password: hash,
        role: "caddy",
        sessionVersion: 0,
      },
    });
    targetUserId = uCaddy.id;
    leaderUserId = uLeader.id;
    retiredUserId = uRetired.id;
    adminUserId = uAdmin.id;
    noSubUserId = uNoSub.id;
    adminId = uAdmin.id;

    const adminCookie = await cookieFor({ ...uAdmin, role: "admin" });
    const caddyCookie = await cookieFor({ ...uCaddy, role: "caddy" });

    section("auth / confirm / 1-target");
    {
      const unauth = await postTest(undefined, {
        userId: targetUserId,
        confirm: TEST_PUSH_CONFIRM,
      });
      assert(unauth.status === 401, "unauth POST 401");
      const unauthBody = await unauth.json();
      assert(unauthBody.error === "unauthorized", "unauth code");
      assert(!jsonHasSecrets(unauthBody), "unauth no secrets");

      const caddyPost = await postTest(caddyCookie, {
        userId: targetUserId,
        confirm: TEST_PUSH_CONFIRM,
      });
      assert(caddyPost.status === 401, "caddy POST 401");

      const noConfirm = await postTest(adminCookie, { userId: targetUserId });
      assert(noConfirm.status === 400, "missing confirm 400");
      const badConfirm = await postTest(adminCookie, {
        userId: targetUserId,
        confirm: "SEND",
      });
      assert(badConfirm.status === 400, "wrong confirm 400");
      const badBody = await badConfirm.json();
      assert(badBody.error === "invalid_confirm", "invalid_confirm code");

      try {
        parseTestPushRequest({ userId: [1, 2], confirm: TEST_PUSH_CONFIRM });
        assert(false, "array userId rejected");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "invalid_target",
          "batch userId invalid_target"
        );
      }
      try {
        parseTestPushRequest({ userIds: [1, 2], confirm: TEST_PUSH_CONFIRM });
        assert(false, "userIds rejected");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "invalid_target",
          "userIds invalid_target"
        );
      }
    }

    section("no_subscription / env / retired / roles");
    {
      const none = await sendTestPushToUser(prisma, noSubUserId, TEST_PUSH_CONFIRM, {
        sendFn: async () => {
          throw new Error("should-not-send");
        },
      });
      assert(none.error === "no_subscription", "0 sub → no_subscription");
      assert(none.sent === 0 && none.failed === 0 && none.removedStale === 0, "0 sub aggregates");

      const prev = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
      try {
        await sendTestPushToUser(prisma, targetUserId, TEST_PUSH_CONFIRM);
        assert(false, "missing vapid should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "push_not_configured",
          "missing private → push_not_configured"
        );
        assert((e as { status?: number }).status === 503, "503");
      }
      const http503 = await postTest(adminCookie, {
        userId: targetUserId,
        confirm: TEST_PUSH_CONFIRM,
      });
      assert(http503.status === 503, "HTTP 503 when not configured");
      process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prev;

      try {
        await sendTestPushToUser(prisma, retiredUserId, TEST_PUSH_CONFIRM, {
          sendFn: async () => undefined,
        });
        assert(false, "retired should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "retired",
          "RETIRED blocked"
        );
      }
      try {
        await sendTestPushToUser(prisma, adminUserId, TEST_PUSH_CONFIRM, {
          sendFn: async () => undefined,
        });
        assert(false, "admin target should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "invalid_target",
          "admin not a target"
        );
      }
    }

    const ep1 = `https://push.example/ep/${tag}/1`;
    const ep2 = `https://push.example/ep/${tag}/2`;
    await prisma.pushSubscription.create({
      data: {
        userId: targetUserId,
        endpoint: ep1,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    await prisma.pushSubscription.create({
      data: {
        userId: targetUserId,
        endpoint: ep2,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });
    await prisma.pushSubscription.create({
      data: {
        userId: leaderUserId,
        endpoint: `https://push.example/ep/${tag}/leader`,
        p256dh: fakeP256(),
        auth: fakeAuth(),
        enabled: true,
      },
    });

    section("send mock success / multi / partial / stale / failure");
    {
      assert(isGoneStatus(404) && isGoneStatus(410), "404/410 gone");
      assert(!isGoneStatus(500), "500 not gone");

      let n = 0;
      const one = await sendTestPushToUser(prisma, leaderUserId, TEST_PUSH_CONFIRM, {
        sendFn: async () => {
          n += 1;
        },
      });
      assert(one.sent === 1 && one.failed === 0 && one.removedStale === 0, "success 1 device");
      assert(n === 1, "provider called once");
      const leaderRow = await prisma.pushSubscription.findFirst({
        where: { userId: leaderUserId },
      });
      assert(Boolean(leaderRow?.lastSuccessAt), "lastSuccessAt set");

      const multi = await sendTestPushToUser(prisma, targetUserId, TEST_PUSH_CONFIRM, {
        sendFn: async () => undefined,
      });
      assert(multi.sent === 2 && multi.failed === 0, "success multi-device");

      await prisma.pushSubscription.updateMany({
        where: { userId: targetUserId },
        data: { lastSuccessAt: null, lastFailureAt: null },
      });

      const calls: string[] = [];
      const mixed = await sendTestPushToUser(prisma, targetUserId, TEST_PUSH_CONFIRM, {
        sendFn: async (sub) => {
          calls.push(sub.endpoint.slice(-2));
          if (sub.endpoint.endsWith("/1")) {
            const err = new Error("gone") as Error & { statusCode: number };
            err.statusCode = 410;
            throw err;
          }
          const err = new Error("fail") as Error & { statusCode: number };
          err.statusCode = 500;
          throw err;
        },
      });
      assert(mixed.removedStale === 1, "410 stale deleted");
      assert(mixed.failed === 1, "500 lastFailure");
      assert(mixed.sent === 0, "no success in mixed");
      const remaining = await prisma.pushSubscription.findMany({
        where: { userId: targetUserId },
      });
      assert(remaining.length === 1, "one sub remains");
      assert(Boolean(remaining[0]?.lastFailureAt), "lastFailureAt set");
      assert(!remaining.some((r) => r.endpoint.endsWith("/1")), "410 row gone");
    }

    section("HTTP response no secrets + search");
    {
      const res = await postTest(adminCookie, {
        userId: leaderUserId,
        confirm: TEST_PUSH_CONFIRM,
      });
      // real web-push would network; without mock on route this may fail.
      // We only assert the JSON never includes secrets regardless of status.
      const body = await res.json();
      assert(!jsonHasSecrets(body), "POST response no endpoint/keys");
      assert(!secretKeys().some((k) => Object.prototype.hasOwnProperty.call(body, k)), "no secret keys");

      const empty = await getTargets(adminCookie, "");
      assert(empty.status === 200, "empty q 200");
      const emptyBody = await empty.json();
      assert(Array.isArray(emptyBody.results) && emptyBody.results.length === 0, "empty q []");
      assert(!jsonHasSecrets(emptyBody), "search empty no secrets");

      const unauthGet = await getTargets(undefined, "김");
      assert(unauthGet.status === 401, "unauth search 401");

      const hits = await searchPushTestTargets(prisma, `${tag}_김`);
      assert(hits.length >= 1, "name search hits");
      assert(hits[0]?.name.includes("김테스트"), "name match");
      assert(typeof hits[0]?.subscriptionCount === "number", "count is number");
      assert(!("endpoint" in (hits[0] ?? {})), "no endpoint field");
      assert(hits.every((h) => h.role === "caddy" || h.role === "leader"), "caddy/leader only");

      const teamHits = await searchPushTestTargets(prisma, "2조");
      assert(
        teamHits.some((h) => h.userId === leaderUserId),
        "team search finds leader"
      );
      const retiredHits = await searchPushTestTargets(prisma, `${tag}_박`);
      assert(
        retiredHits.every((h) => h.userId !== retiredUserId),
        "RETIRED excluded from search"
      );

      const many = await searchPushTestTargets(prisma, "조");
      assert(many.length <= PUSH_TEST_SEARCH_LIMIT, "search max 20");

      const ui = read("src/app/manage/push-test/page.tsx");
      assert(ui.includes("푸시 알림 테스트"), "page title");
      assert(ui.includes("테스트 알림 보내기"), "send button");
      assert(ui.includes("이 캐디 1명에게 테스트 알림을 보냅니다."), "confirm copy");
      assert(ui.includes("알림 등록 기기"), "device count copy");
      assert(TEST_PUSH_TITLE === "VERTHILL 알림 테스트", "fixed title");
      assert(TEST_PUSH_BODY.includes("정상적으로 도착"), "fixed body");
      assert(TEST_PUSH_URL === "/caddy", "fixed url");
      assert(TEST_PUSH_CONFIRM === "SEND_TEST_PUSH", "confirm token");
    }
  } finally {
    await prisma.pushSubscription.deleteMany({
      where: { user: { username: { startsWith: tag } } },
    });
    await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
    if (caddyId) await prisma.caddy.deleteMany({ where: { id: { in: [caddyId, leaderId, retiredId].filter(Boolean) } } });
    process.env.SESSION_SECRET = prevSecret;
    if (prevPub) process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    else delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    if (prevPriv) process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
    else delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    if (prevSub) process.env.WEB_PUSH_SUBJECT = prevSub;
    else delete process.env.WEB_PUSH_SUBJECT;
  }

  // silence unused
  void adminId;
  void secretKeys;

  if (failed > 0) {
    console.error(`\nFAILED: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
}

main().catch((e) => {
  console.error(e instanceof Error ? e.message : e);
  process.exit(1);
});
