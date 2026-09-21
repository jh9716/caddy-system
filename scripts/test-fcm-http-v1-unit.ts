/**
 * FCM HTTP v1 sender + native fan-out (mocked network, no prod).
 * 실행: npm run test:fcm-http-v1-unit
 */
import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  isFcmSendEnabled,
  isFcmServerConfigured,
  normalizeFirebasePrivateKey,
  readFcmServiceAccount,
  hasPushDeliveryTargets,
  canAttemptNativePushSend,
} from "../src/lib/fcmCredentials";
import {
  buildFcmHttpV1Message,
  classifyFcmHttpResponse,
  FCM_ANDROID_CHANNEL_ID,
  fcmMessagesSendUrl,
  sendFcmHttpV1,
  type FcmFetchFn,
} from "../src/lib/fcmHttpV1";
import {
  deliverNativePushTokens,
  loadEnabledDevicePushTokens,
} from "../src/lib/nativePushDelivery";
import { fanoutPushToUserIds } from "../src/lib/pushFanout";

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

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

const { privateKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});

const pemNewlines = normalizeFirebasePrivateKey(privateKey);
const pemEscaped = normalizeFirebasePrivateKey(privateKey.replace(/\n/g, "\\n"));
const pemQuoted = normalizeFirebasePrivateKey(`"${privateKey.replace(/\n/g, "\\n")}"`);

console.log("== credential env names / PEM normalize ==");
assert(read("src/lib/fcmCredentials.ts").includes("FIREBASE_PROJECT_ID"), "reads FIREBASE_PROJECT_ID");
assert(read("src/lib/fcmCredentials.ts").includes("FIREBASE_CLIENT_EMAIL"), "reads FIREBASE_CLIENT_EMAIL");
assert(read("src/lib/fcmCredentials.ts").includes("FIREBASE_PRIVATE_KEY"), "reads FIREBASE_PRIVATE_KEY");
assert(isFcmSendEnabled({} as NodeJS.ProcessEnv) === false, "FCM_SEND_ENABLED unset → false");
assert(isFcmSendEnabled({ FCM_SEND_ENABLED: "1" } as NodeJS.ProcessEnv) === true, "FCM_SEND_ENABLED=1 → true");
assert(isFcmSendEnabled({ FCM_SEND_ENABLED: "true" } as NodeJS.ProcessEnv) === false, "truthy string is not 1");
assert(isFcmServerConfigured({} as NodeJS.ProcessEnv) === false, "missing creds → not configured");
assert(pemNewlines != null && pemEscaped != null && pemNewlines === pemEscaped, "\\n and real newlines match");
assert(pemQuoted != null && pemQuoted === pemNewlines, "quoted Vercel \\n form matches");
assert(normalizeFirebasePrivateKey("not-a-key") == null, "junk key rejected");
assert(
  readFcmServiceAccount({
    FIREBASE_PROJECT_ID: "demo-proj",
    FIREBASE_CLIENT_EMAIL: "svc@demo.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: privateKey.replace(/\n/g, "\\n"),
  } as NodeJS.ProcessEnv) != null,
  "escaped PEM + project + email parses"
);
assert(
  !/console\.(log|info|debug|error)\([^)]*(privateKey|FIREBASE_PRIVATE_KEY|access_token)/.test(
    read("src/lib/fcmCredentials.ts")
  ) &&
    !/console\.(log|info|debug|error)\([^)]*(privateKey|access_token|assertion)/.test(
      read("src/lib/fcmHttpV1.ts")
    ),
  "credential files do not log secrets"
);

console.log("== FCM message + classify ==");
const msg = buildFcmHttpV1Message("tok-1", {
  title: "T",
  body: "B",
  url: "/notice/3",
  tag: "notice-3",
});
assert(msg.message.token === "tok-1", "message has token");
assert(msg.message.notification.title === "T", "notification title");
assert(msg.message.data.url === "/notice/3", "data.url relative");
assert(msg.message.data.tag === "notice-3", "data.tag");
assert(msg.message.android.notification.channelId === FCM_ANDROID_CHANNEL_ID, "channel verthill");
assert(FCM_ANDROID_CHANNEL_ID === "verthill", "channel id constant");
const evil = buildFcmHttpV1Message("tok-1", {
  title: "T",
  body: "B",
  url: "https://evil.example/",
});
assert(evil.message.data.url == null, "absolute data.url omitted");
assert(classifyFcmHttpResponse(200, { name: "projects/p/messages/1" }) === "sent", "2xx sent");
assert(
  classifyFcmHttpResponse(404, {
    error: { status: "NOT_FOUND", details: [{ errorCode: "UNREGISTERED" }] },
  }) === "gone",
  "UNREGISTERED → gone"
);
assert(
  classifyFcmHttpResponse(400, {
    error: { status: "INVALID_ARGUMENT", message: "The registration token is not a valid FCM registration token" },
  }) === "gone",
  "invalid registration token → gone"
);
assert(classifyFcmHttpResponse(429, { error: { status: "RESOURCE_EXHAUSTED" } }) === "failed", "429 → failed");
assert(classifyFcmHttpResponse(503, { error: { status: "UNAVAILABLE" } }) === "failed", "5xx → failed");
assert(fcmMessagesSendUrl("verthill").includes("/v1/projects/verthill/messages:send"), "HTTP v1 URL");

console.log("== mocked HTTP v1 send / fail-closed ==");
async function runHttp() {
  const env = {
    FCM_SEND_ENABLED: "1",
    FIREBASE_PROJECT_ID: "verthill",
    FIREBASE_CLIENT_EMAIL: "svc@verthill.iam.gserviceaccount.com",
    FIREBASE_PRIVATE_KEY: privateKey,
  } as NodeJS.ProcessEnv;

  let oauth = 0;
  let fcm = 0;
  const okFetch: FcmFetchFn = async (url, init) => {
    if (url.includes("oauth2.googleapis.com")) {
      oauth += 1;
      assert(init.body.includes("assertion="), "oauth jwt grant");
      return { status: 200, json: async () => ({ access_token: "atok" }) };
    }
    fcm += 1;
    const body = JSON.parse(init.body) as { message: { data: { url?: string }; android: { notification: { channelId: string } } } };
    assert(url.includes("/v1/projects/verthill/messages:send"), "fcm project URL");
    assert(init.headers.Authorization === "Bearer atok", "bearer access token");
    assert(body.message.android.notification.channelId === "verthill", "request channel");
    assert(body.message.data.url === "/caddy", "request data.url");
    return { status: 200, json: async () => ({ name: "projects/verthill/messages/1" }) };
  };
  const sent = await sendFcmHttpV1("device-token", { title: "t", body: "b", url: "/caddy" }, {
    env,
    fetchFn: okFetch,
    nowSec: 1_700_000_000,
  });
  assert(sent === "sent" && oauth === 1 && fcm === 1, "mocked HTTP v1 send");

  let live = 0;
  const skipped = await deliverNativePushTokens(
    {} as never,
    [{ id: 1, userId: 1, token: "t", platform: "ANDROID" }],
    { title: "t", body: "b", url: "/caddy" },
    {
      env: { ...env, FCM_SEND_ENABLED: "" } as NodeJS.ProcessEnv,
      fetchFn: async () => {
        live += 1;
        return { status: 200, json: async () => ({}) };
      },
    }
  );
  assert(skipped.reason === "send_disabled" && live === 0, "unset FCM_SEND_ENABLED → network 0");

  const disabled = await deliverNativePushTokens(
    {} as never,
    [{ id: 1, userId: 1, token: "t", platform: "ANDROID" }],
    { title: "t", body: "b", url: "/caddy" },
    { env: {} as NodeJS.ProcessEnv }
  );
  assert(disabled.reason === "send_disabled" && disabled.sent === 0, "no flag → skip");

  const missing = await deliverNativePushTokens(
    {} as never,
    [{ id: 1, userId: 1, token: "t", platform: "ANDROID" }],
    { title: "t", body: "b", url: "/caddy" },
    { env: { FCM_SEND_ENABLED: "1" } as NodeJS.ProcessEnv }
  );
  assert(missing.reason === "not_configured", "enabled without creds → fail-closed");

  const rows = new Map<number, { id: number; enabled: boolean; lastFailureAt: Date | null }>([
    [1, { id: 1, enabled: true, lastFailureAt: null }],
    [2, { id: 2, enabled: true, lastFailureAt: null }],
  ]);
  const db = {
    devicePushToken: {
      findMany: async () => [
        { id: 1, userId: 9, token: "tok-a", platform: "ANDROID" },
        { id: 2, userId: 9, token: "tok-b", platform: "ANDROID" },
      ],
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: { enabled?: boolean; lastFailureAt?: Date };
      }) => {
        const row = rows.get(where.id);
        if (!row) return { count: 0 };
        if (data.enabled === false) row.enabled = false;
        if (data.lastFailureAt) row.lastFailureAt = data.lastFailureAt;
        return { count: 1 };
      },
    },
  };

  await deliverNativePushTokens(
    db as never,
    [
      { id: 1, userId: 9, token: "tok-a", platform: "ANDROID" },
      { id: 2, userId: 9, token: "tok-b", platform: "ANDROID" },
    ],
    { title: "t", body: "b", url: "/notice/1" },
    {
      sendFn: async (token) => (token === "tok-a" ? "gone" : "failed"),
    }
  );
  assert(rows.get(1)?.enabled === false, "UNREGISTERED/gone disables only that token");
  assert(rows.get(2)?.enabled === true, "429/failed does not disable token");
  assert(rows.get(2)?.lastFailureAt instanceof Date, "transient failure sets lastFailureAt");

  const loaded = await loadEnabledDevicePushTokens(db as never, [9]);
  assert(loaded.length === 2, "findMany still returns enabled rows from mock");

  console.log("== fan-out web / native / both / multi-device ==");
  assert(hasPushDeliveryTargets(0, 1) === true, "native-only is a recipient");
  assert(hasPushDeliveryTargets(1, 0) === true, "web-only is a recipient");
  assert(hasPushDeliveryTargets(0, 0) === false, "empty is not a recipient");
  assert(canAttemptNativePushSend({ sendFn: async () => "sent" }) === true, "injected sendFn can attempt");
  assert(canAttemptNativePushSend({}, {} as NodeJS.ProcessEnv) === false, "no flag cannot attempt");

  const tokenStore = [
    { id: 11, userId: 1, token: "n1", platform: "ANDROID" as const },
    { id: 12, userId: 1, token: "n2", platform: "ANDROID" as const },
    { id: 21, userId: 2, token: "n3", platform: "ANDROID" as const },
  ];
  const fanDb = {
    devicePushToken: {
      findMany: async ({ where }: { where: { userId: { in: number[] } } }) =>
        tokenStore.filter((r) => where.userId.in.includes(r.userId)),
      updateMany: async () => ({ count: 0 }),
    },
    pushSubscription: {
      updateMany: async () => ({ count: 0 }),
      deleteMany: async () => ({ count: 0 }),
    },
  };
  const creds = { subject: "mailto:a@b.c", publicKey: "p", privateKey: "s" };
  const nativeHits: string[] = [];
  const webHits: string[] = [];

  const nativeOnly = await fanoutPushToUserIds(fanDb as never, {
    userIds: [2],
    webMappings: [],
    payload: { title: "t", body: "b", url: "/caddy" },
    credentials: creds,
    concurrency: 2,
    webSendFn: async () => {
      webHits.push("web");
    },
    nativeSendFn: async (token) => {
      nativeHits.push(token);
      return "sent";
    },
  });
  assert(nativeOnly.web.deliveries === 0, "native-only web deliveries 0");
  assert(nativeOnly.native.sent === 1 && nativeHits.includes("n3"), "native-only FCM once");
  assert(webHits.length === 0, "native-only does not send web");

  nativeHits.length = 0;
  const webOnly = await fanoutPushToUserIds(fanDb as never, {
    userIds: [99],
    webMappings: [
      { id: 1, userId: 99, endpoint: "https://e/1", p256dh: "x", auth: "y" },
    ],
    payload: { title: "t", body: "b", url: "/caddy" },
    credentials: creds,
    concurrency: 2,
    webSendFn: async (sub) => {
      webHits.push(sub.endpoint);
    },
    nativeSendFn: async (token) => {
      nativeHits.push(token);
      return "sent";
    },
  });
  assert(webOnly.web.sent === 1 && webHits.includes("https://e/1"), "web-only sends web");
  assert(webOnly.native.sent === 0 && nativeHits.length === 0, "web-only no native token");

  nativeHits.length = 0;
  webHits.length = 0;
  const both = await fanoutPushToUserIds(fanDb as never, {
    userIds: [1],
    webMappings: [
      { id: 7, userId: 1, endpoint: "https://e/web", p256dh: "x", auth: "y" },
    ],
    payload: { title: "t", body: "b", url: "/board?date=2026-09-21" },
    credentials: creds,
    concurrency: 2,
    webSendFn: async (sub) => {
      webHits.push(sub.endpoint);
    },
    nativeSendFn: async (token) => {
      nativeHits.push(token);
      return "sent";
    },
  });
  assert(both.web.sent === 1 && both.native.sent === 2, "same user web + two native devices");
  assert(nativeHits.includes("n1") && nativeHits.includes("n2"), "multi-device fan-out");

  console.log("== migration additive / leak guards ==");
  const sql = read("prisma/migrations/20260921120000_device_push_token/migration.sql");
  assert(!/DROP /i.test(sql), "migration has no DROP");
  assert(
    !/ALTER TABLE "PushSubscription"|DROP TABLE "PushSubscription"/.test(sql),
    "migration does not touch PushSubscription"
  );
  assert(sql.includes('CREATE TABLE "DevicePushToken"'), "creates DevicePushToken");
  assert(sql.includes("DevicePushToken_userId_token_key"), "unique(userId, token)");
  assert(sql.includes("DevicePushToken_token_idx"), "token index");
  assert(sql.includes("DevicePushToken_userId_fkey"), "User FK");
  assert(sql.includes("ON DELETE CASCADE"), "FK cascade on User delete");
  const schema = read("prisma/schema.prisma");
  assert(schema.includes("model PushSubscription"), "PushSubscription model stays");
  assert(schema.includes("@@unique([userId, endpoint])"), "PushSubscription unique unchanged");
  assert(
    !read("src/lib/kakaoNativeBridge.ts").includes("FCM") &&
      !read("src/app/api/auth/kakao/native-session/route.ts").includes("devicePushToken"),
    "Kakao files stay off FCM path"
  );
  assert(
    read(".gitignore").includes("android/app/google-services.json"),
    "json stays gitignored"
  );

  if (failed) {
    console.error(`\nFAILED ${failed} / ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

void runHttp();
