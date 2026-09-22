/**
 * Native-only admin push test. local caddy_local only.
 * Mock sendFn / FCM gate off: no live FCM, no Web Push network.
 * 실행: npm run test:native-push-test-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NextRequest } from "next/server";
import bcrypt from "bcryptjs";
import type { PrismaClient } from "@prisma/client";
import { prisma } from "../src/lib/prisma";
import {
  SESSION_COOKIE_NAME,
  buildSessionClaims,
  signSessionClaims,
} from "../src/lib/sessionCookies";
import { assertLocalDatabaseUrl } from "./assertLocalDatabaseUrl";
import { buildFcmHttpV1Message, FCM_ANDROID_CHANNEL_ID } from "../src/lib/fcmHttpV1";
import {
  NATIVE_TEST_PUSH_BODY,
  NATIVE_TEST_PUSH_TAG,
  NATIVE_TEST_PUSH_TITLE,
  NATIVE_TEST_PUSH_URL,
  TEST_PUSH_CONFIRM,
} from "../src/lib/webPushTestConstants";
import {
  countEnabledAndroidDeviceTokens,
  parseTestPushRequest,
  sendNativeTestPushToSelf,
  sendTestPushToUser,
} from "../src/lib/webPushTestSend";
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

function sliceBetween(src: string, start: string, end: string): string {
  const i = src.indexOf(start);
  const j = src.indexOf(end, i + start.length);
  return i >= 0 && j > i ? src.slice(i, j) : "";
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
  const req = new NextRequest("https://www.verthill.kr/api/push/test", {
    method: "POST",
    headers: {
      ...(cookie ? { cookie } : {}),
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return POST_TEST(req);
}

function guardedDb(): PrismaClient {
  let writes = 0;
  return {
    user: {
      findUnique: (args: unknown) => prisma.user.findUnique(args as never),
    },
    devicePushToken: {
      findFirst: (args: unknown) => prisma.devicePushToken.findFirst(args as never),
      findMany: () => {
        throw new Error("unexpected findMany");
      },
      count: (args: unknown) => prisma.devicePushToken.count(args as never),
      updateMany: () => {
        writes += 1;
        throw new Error("unexpected device write");
      },
    },
    pushSubscription: new Proxy(
      {},
      {
        get() {
          throw new Error("pushSubscription touched");
        },
      }
    ),
    __writes: () => writes,
  } as unknown as PrismaClient & { __writes: () => number };
}

async function main() {
  assertLocalDatabaseUrl(process.env.DATABASE_URL);
  const prevSecret = process.env.SESSION_SECRET;
  const prevFcm = process.env.FCM_SEND_ENABLED;
  const prevPub = process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  const prevPriv = process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  const prevSub = process.env.WEB_PUSH_SUBJECT;
  process.env.SESSION_SECRET = "native-push-test-unit-secret-32chars!";
  delete process.env.FCM_SEND_ENABLED;
  delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
  delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
  delete process.env.WEB_PUSH_SUBJECT;
  assert(process.env.FCM_SEND_ENABLED !== "1", "live FCM gate stays off");

  const tag = `nft_${Date.now()}`;
  const hash = await bcrypt.hash("x", 4);
  const tokenOld = `nft-old-${tag}`;
  const tokenNew = `nft-new-${tag}`;
  let adminId = 0;
  let otherId = 0;

  try {
    section("source");
    {
      const sendSrc = read("src/lib/webPushTestSend.ts");
      const nativeFn = sliceBetween(
        sendSrc,
        "export async function sendNativeTestPushToSelf",
        "export async function sendTestPushToUser"
      );
      assert(nativeFn.includes("deliverNativePushTokens"), "native calls deliverNativePushTokens");
      assert(!nativeFn.includes("deliverWebPush"), "native fn has no web push send");
      assert(!nativeFn.includes("pushSubscription"), "native fn does not query PushSubscription");
      const route = read("src/app/api/push/test/route.ts");
      assert(route.includes("requireAdmin"), "route keeps requireAdmin");
      assert(route.includes("auth.userId"), "route passes session user id");
      assert(route.includes("requestedUserId !== targetUserId"), "mismatched userId rejected");
      const ui = read("src/app/manage/push-test/PushTestClient.tsx");
      const nativeUi = sliceBetween(ui, "async function sendNative", "return (");
      assert(ui.includes("내 Android 앱 알림 테스트"), "native card title");
      assert(
        ui.includes("현재 이 관리자 계정에 등록된 VERTHILL 앱으로 테스트 알림을 보냅니다."),
        "native card description"
      );
      assert(ui.includes("내 앱으로 테스트 알림 보내기"), "native button label");
      assert(ui.includes("nativeTokenCount < 1") || ui.includes("!hasNativeToken"), "missing token disables button");
      assert(ui.includes("등록된 Android 앱 알림이 없습니다."), "missing token guidance");
      assert(ui.includes("nativeSending"), "loading lock");
      assert(nativeUi.includes('channel: "native"'), "ui sends native channel");
      assert(!nativeUi.includes("userId"), "ui native body has no userId");
      const nativeCard = sliceBetween(ui, '<section className="pt-self">', "캐디 이름 검색");
      assert(nativeCard.length > 0, "native card is above search");
      assert(!nativeCard.includes("subscriptionCount"), "native card ignores web subscription count");
      assert(!nativeCard.includes("canNative ?"), "native card is not hidden");
      assert(ui.includes("subscriptionCount < 1"), "web button still checks subscriptions");
      assert(ui.includes("테스트 알림 보내기"), "web send button kept");
      const page = read("src/app/manage/push-test/page.tsx");
      assert(page.includes("countEnabledAndroidDeviceTokens"), "page counts own tokens");
      assert(page.includes("resolvePushSubscriptionUserId"), "page resolves env admin to db user");
      assert(!page.includes('typeof auth.userId === "number"'), "page does not skip null session uid");
      assert(page.includes("nativeTokenCount"), "page passes token count");
      assert(route.includes("resolvePushSubscriptionUserId"), "send uses the same self user");
      const migrations = fs.readdirSync(path.join(process.cwd(), "prisma/migrations"));
      assert(
        !migrations.some((n) => /native-fcm-e2e|native-push-test/i.test(n)),
        "no native test migration"
      );
      const message = buildFcmHttpV1Message("unit-token", {
        title: NATIVE_TEST_PUSH_TITLE,
        body: NATIVE_TEST_PUSH_BODY,
        url: NATIVE_TEST_PUSH_URL,
        tag: NATIVE_TEST_PUSH_TAG,
      });
      assert(message.message.notification.title === "VERTHILL", "payload title");
      assert(
        message.message.notification.body === NATIVE_TEST_PUSH_BODY,
        "payload body"
      );
      assert(message.message.data.url === "/", "payload url");
      assert(message.message.data.tag === "native-fcm-e2e", "payload tag");
      assert(
        message.message.android.notification.channelId === FCM_ANDROID_CHANNEL_ID &&
          FCM_ANDROID_CHANNEL_ID === "verthill",
        "channel verthill"
      );
    }

    const admin = await prisma.user.create({
      data: {
        username: `${tag}_admin`,
        password: hash,
        role: "admin",
        sessionVersion: 0,
      },
    });
    const other = await prisma.user.create({
      data: {
        username: `${tag}_other`,
        password: hash,
        role: "caddy",
        sessionVersion: 0,
      },
    });
    adminId = admin.id;
    otherId = other.id;
    const adminCookie = await cookieFor({ ...admin, role: "admin" });
    const caddyCookie = await cookieFor({ ...other, role: "caddy" });

    section("auth");
    {
      const unauth = await postTest(undefined, {
        channel: "native",
        confirm: TEST_PUSH_CONFIRM,
      });
      assert(unauth.status === 401, "unauthenticated 401");
      const caddy = await postTest(caddyCookie, {
        channel: "native",
        confirm: TEST_PUSH_CONFIRM,
      });
      assert(caddy.status === 401, "non-admin 401");
      const parsed = parseTestPushRequest({
        userId: otherId,
        confirm: TEST_PUSH_CONFIRM,
      });
      assert(parsed.channel === "web" && parsed.userId === otherId, "omitted channel stays web");
    }

    section("no native token");
    {
      assert((await countEnabledAndroidDeviceTokens(prisma, adminId)) === 0, "count 0");
      let calls = 0;
      const none = await sendNativeTestPushToSelf(guardedDb(), adminId, {
        sendFn: async () => {
          calls += 1;
          return "sent";
        },
      });
      assert(none.error === "no_native_token" && none.sent === 0, "admin without token");
      assert(calls === 0, "no token does not call native send");
      const http = await postTest(adminCookie, {
        channel: "native",
        confirm: TEST_PUSH_CONFIRM,
      });
      const body = await http.json();
      assert(http.status === 200 && body.error === "no_native_token", "http no token");
      assert(body.sent === 0, "http no token sent 0");
    }

    const older = await prisma.devicePushToken.create({
      data: { userId: adminId, token: tokenOld, platform: "ANDROID", enabled: true },
    });
    const newer = await prisma.devicePushToken.create({
      data: { userId: adminId, token: tokenNew, platform: "ANDROID", enabled: true },
    });
    await prisma.devicePushToken.update({
      where: { id: newer.id },
      data: { enabled: true },
    });

    section("one native send, no web push, no success write");
    {
      assert((await countEnabledAndroidDeviceTokens(prisma, adminId)) === 2, "two enabled tokens");
      const before = await prisma.devicePushToken.findUnique({
        where: { id: newer.id },
        select: { enabled: true, lastFailureAt: true, updatedAt: true },
      });
      const db = guardedDb();
      let calls = 0;
      let sawNew = false;
      const sent = await sendNativeTestPushToSelf(db, adminId, {
        sendFn: async (token, payload) => {
          calls += 1;
          sawNew = token === tokenNew;
          assert(payload.title === NATIVE_TEST_PUSH_TITLE, "send title");
          assert(payload.body === NATIVE_TEST_PUSH_BODY, "send body");
          assert(payload.url === NATIVE_TEST_PUSH_URL, "send url");
          assert(payload.tag === NATIVE_TEST_PUSH_TAG, "send tag");
          return "sent";
        },
      });
      assert(calls === 1, "deliverNativePushTokens once");
      assert(sawNew, "only newest enabled token");
      assert(sent.sent === 1 && sent.failed === 0 && sent.deliveries === 1, "one success");
      assert((db as unknown as { __writes: () => number }).__writes() === 0, "success db write 0");
      const after = await prisma.devicePushToken.findUnique({
        where: { id: newer.id },
        select: { enabled: true, lastFailureAt: true, updatedAt: true },
      });
      assert(after?.enabled === true && after.lastFailureAt == null, "token stays enabled");
      assert(
        before && after && before.updatedAt.getTime() === after.updatedAt.getTime(),
        "success does not touch updatedAt"
      );
      void older;
    }

    section("FCM off network 0 and foreign userId");
    {
      let fetches = 0;
      const offEnv = { NODE_ENV: process.env.NODE_ENV } as NodeJS.ProcessEnv;
      offEnv.FCM_SEND_ENABLED = "0";
      const off = await sendNativeTestPushToSelf(prisma, adminId, {
        env: offEnv,
        fetchFn: async () => {
          fetches += 1;
          throw new Error("network");
        },
      });
      assert(fetches === 0, "FCM off network 0");
      assert(off.sent === 0 && off.error === "fcm_send_disabled", "FCM off send 0");

      const origFetch = globalThis.fetch;
      let httpFetches = 0;
      globalThis.fetch = async (...args) => {
        httpFetches += 1;
        return origFetch(...args);
      };
      try {
        const foreign = await postTest(adminCookie, {
          channel: "native",
          confirm: TEST_PUSH_CONFIRM,
          userId: otherId,
          title: "EVIL",
        });
        const foreignBody = await foreign.json();
        assert(foreign.status === 400 && foreignBody.error === "invalid_target", "foreign userId rejected");
        const self = await postTest(adminCookie, {
          channel: "native",
          confirm: TEST_PUSH_CONFIRM,
          userId: adminId,
        });
        const selfBody = await self.json();
        assert(self.status === 200 && selfBody.sent === 0, "own userId allowed but FCM off");
        assert(selfBody.error === "fcm_send_disabled", "own userId hits FCM gate");
        assert(!JSON.stringify(selfBody).includes(tokenNew), "response omits device token");
        const omitted = await postTest(adminCookie, {
          channel: "native",
          confirm: TEST_PUSH_CONFIRM,
        });
        const omittedBody = await omitted.json();
        assert(omitted.status === 200 && omittedBody.error === "fcm_send_disabled", "omitted userId uses session");
        const envCookie = await cookieFor({
          id: null,
          username: admin.username,
          role: "admin",
          sessionVersion: 0,
        });
        const envSelf = await postTest(envCookie, {
          channel: "native",
          confirm: TEST_PUSH_CONFIRM,
        });
        const envBody = await envSelf.json();
        assert(
          envSelf.status === 200 && envBody.error === "fcm_send_disabled" && envBody.sent === 0,
          "env admin resolves own db user and does not send while FCM is off"
        );
        const envForeign = await postTest(envCookie, {
          channel: "native",
          confirm: TEST_PUSH_CONFIRM,
          userId: otherId,
        });
        const envForeignBody = await envForeign.json();
        assert(
          envForeign.status === 400 && envForeignBody.error === "invalid_target",
          "env admin cannot target another user"
        );
      } finally {
        globalThis.fetch = origFetch;
      }
      assert(httpFetches === 0, "http native network 0");
    }

    section("web push regression");
    {
      let webCalls = 0;
      let nativeCalls = 0;
      try {
        await sendTestPushToUser(prisma, otherId, TEST_PUSH_CONFIRM, {
          sendFn: async () => {
            webCalls += 1;
          },
          nativeSendFn: async () => {
            nativeCalls += 1;
            return "sent";
          },
        });
        assert(false, "unconfigured web send should throw");
      } catch (e) {
        assert(
          e instanceof Error && (e as { code?: string }).code === "push_not_configured",
          "web mode still requires web push config"
        );
      }
      assert(webCalls === 0 && nativeCalls === 0, "unconfigured web send calls nothing");
      const httpWeb = await postTest(adminCookie, {
        channel: "web",
        userId: otherId,
        confirm: TEST_PUSH_CONFIRM,
      });
      const webBody = await httpWeb.json();
      assert(httpWeb.status === 503 && webBody.error === "push_not_configured", "web route still gated");
    }
  } finally {
    if (adminId || otherId) {
      await prisma.devicePushToken.deleteMany({
        where: { userId: { in: [adminId, otherId].filter((id) => id > 0) } },
      });
      await prisma.user.deleteMany({ where: { username: { startsWith: tag } } });
    }
    if (prevSecret == null) delete process.env.SESSION_SECRET;
    else process.env.SESSION_SECRET = prevSecret;
    if (prevFcm == null) delete process.env.FCM_SEND_ENABLED;
    else process.env.FCM_SEND_ENABLED = prevFcm;
    if (prevPub == null) delete process.env.WEB_PUSH_VAPID_PUBLIC_KEY;
    else process.env.WEB_PUSH_VAPID_PUBLIC_KEY = prevPub;
    if (prevPriv == null) delete process.env.WEB_PUSH_VAPID_PRIVATE_KEY;
    else process.env.WEB_PUSH_VAPID_PRIVATE_KEY = prevPriv;
    if (prevSub == null) delete process.env.WEB_PUSH_SUBJECT;
    else process.env.WEB_PUSH_SUBJECT = prevSub;
  }

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
