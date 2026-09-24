/**
 * Native App V1 Phase 2 — PWA hide + FCM foundation (no network, no prod).
 * 실행: npm run test:native-push-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  isCapacitorNativePlatform,
  shouldHidePwaInstallUi,
  shouldUseNativePushUi,
} from "../src/lib/nativePlatform";
import {
  resolvePwaInstallSurface,
  shouldShowHomeInstallCta,
} from "../src/lib/pwaInstall";
import {
  NATIVE_PUSH_UI_AVAILABLE,
  NATIVE_PUSH_UI_BLOCKED,
  NATIVE_PUSH_UI_PERMISSION_NEEDED,
  NATIVE_PUSH_UI_REGISTERED,
  nativePushSurfaceLabel,
  resolveNativePushSurface,
  restoreNativePushUiState,
} from "../src/lib/nativePushUi";
import {
  NativePushTokenError,
  parseNativePushPlatform,
  parseNativePushToken,
} from "../src/lib/nativePushToken";
import {
  assignNativePushPath,
  resolveNativePushOpenPath,
} from "../src/lib/nativePushDeepLink";
import {
  buildNativePushDataPayload,
  deliverNativePushTokens,
  hasDevicePushTokenDelegate,
  isFcmSendEnabled,
  isFcmServerConfigured,
  loadEnabledDevicePushTokens,
} from "../src/lib/nativePushDelivery";
import { nativeTokenRequestInit } from "../src/lib/nativePushHttp";

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

console.log("== official native detection ==");
assert(isCapacitorNativePlatform({ isNativePlatform: true }) === true, "native true");
assert(isCapacitorNativePlatform({ isNativePlatform: false }) === false, "web false");
assert(shouldHidePwaInstallUi({ isNativePlatform: true }) === true, "hide PWA on native");
assert(shouldHidePwaInstallUi({ isNativePlatform: false }) === false, "keep PWA on web");
assert(shouldUseNativePushUi({ isNativePlatform: true }) === true, "native push UI on app");
assert(shouldUseNativePushUi({ isNativePlatform: false }) === false, "web push UI on PWA");
assert(!read("src/lib/nativePlatform.ts").includes("userAgent"), "no UA in detection helper");
assert(
  read("src/components/usePwaInstall.ts").includes("readCapacitorNativePlatform"),
  "install hook uses official native reader"
);

console.log("== PWA install hidden on Capacitor ==");
assert(
  resolvePwaInstallSurface({
    standalone: false,
    ios: false,
    hasBeforeInstallPrompt: true,
    android: true,
    isNativePlatform: true,
  }) === "hidden",
  "native + BIP still hidden"
);
assert(
  resolvePwaInstallSurface({
    standalone: true,
    ios: false,
    hasBeforeInstallPrompt: false,
    isNativePlatform: true,
  }) === "hidden",
  "native standalone still hidden"
);
assert(
  shouldShowHomeInstallCta({
    surface: "samsung-hint",
    installed: false,
    isNativePlatform: true,
  }) === false,
  "home CTA hidden on native"
);
assert(
  resolvePwaInstallSurface({
    standalone: false,
    ios: false,
    hasBeforeInstallPrompt: true,
    android: true,
    isNativePlatform: false,
  }) === "android-prompt",
  "web/PWA Chromium prompt unchanged"
);

console.log("== Native Push surfaces ==");
assert(
  resolveNativePushSurface({
    pluginAvailable: true,
    permission: "granted",
    tokenReady: false,
    serverRegistered: false,
  }) === "available",
  "granted but unregistered → available"
);
assert(
  resolveNativePushSurface({
    pluginAvailable: true,
    permission: "prompt",
    tokenReady: false,
    serverRegistered: false,
  }) === "permission-needed",
  "prompt → permission needed"
);
assert(
  resolveNativePushSurface({
    pluginAvailable: true,
    permission: "granted",
    tokenReady: true,
    serverRegistered: true,
  }) === "registered",
  "granted + token + server → registered"
);
assert(
  resolveNativePushSurface({
    pluginAvailable: true,
    permission: "denied",
    tokenReady: false,
    serverRegistered: false,
  }) === "blocked",
  "denied → blocked"
);
assert(nativePushSurfaceLabel("available") === NATIVE_PUSH_UI_AVAILABLE, "available copy");
assert(
  nativePushSurfaceLabel("permission-needed") === NATIVE_PUSH_UI_PERMISSION_NEEDED,
  "permission copy"
);
assert(nativePushSurfaceLabel("registered") === NATIVE_PUSH_UI_REGISTERED, "registered copy");
assert(nativePushSurfaceLabel("blocked") === NATIVE_PUSH_UI_BLOCKED, "blocked copy");
assert(
  !read("src/lib/nativePushUi.ts").includes("이 기기는 지원하지 않음"),
  "native UI never uses unsupported copy"
);

console.log("== token parse / no leak ==");
assert(parseNativePushToken("abc.def") === "abc.def", "token trims");
try {
  parseNativePushToken("");
  assert(false, "empty token throws");
} catch (e) {
  assert(e instanceof NativePushTokenError, "empty token error");
}
try {
  parseNativePushPlatform("IOS");
  assert(false, "iOS platform throws");
} catch (e) {
  assert(e instanceof NativePushTokenError && e.code === "invalid_platform", "iOS rejected");
}
assert(parseNativePushPlatform("ANDROID") === "ANDROID", "ANDROID ok");
const init = nativeTokenRequestInit("secret-token-value");
assert(init.body.includes("ANDROID"), "body has platform");
assert(!init.body.includes("userId"), "body has no client userId");
assert(
  !/console\.(log|info|debug|error)\([^)]*token/.test(read("src/lib/nativePushBridge.ts")),
  "bridge does not log token"
);
assert(
  !/\blocalStorage\b/.test(read("src/lib/nativePushBridge.ts")),
  "token not in localStorage"
);
{
  const cardSrc = read("src/components/NativePushNotificationCard.tsx");
  const jsx = cardSrc.slice(cardSrc.lastIndexOf("return ("));
  assert(!jsx.includes("readMemoryNativePushToken"), "card JSX does not render token helper");
  assert(!jsx.includes("{token}"), "card does not interpolate token into JSX");
}
assert(
  read("src/components/DevicePushSettings.tsx").includes("if (!ready) return null"),
  "native/web split waits for official Capacitor check"
);
assert(
  !read("src/components/NativePushNotificationCard.tsx").includes("이 기기는 지원하지 않음"),
  "native card source has no Web Push unsupported copy"
);

console.log("== restart token rehydrate / no auto POST ==");
{
  const bridge = read("src/lib/nativePushBridge.ts");
  const card = read("src/components/NativePushNotificationCard.tsx");
  assert(bridge.includes("export async function rehydrateNativePushToken"), "rehydrate helper exists");
  assert(bridge.includes("if (listenersBound) return"), "registration listeners bind once");
  {
    const rehydrateStart = bridge.indexOf("export async function rehydrateNativePushToken");
    const registerStart = bridge.indexOf("export async function registerNativePushDevice");
    const rehydrateFn = bridge.slice(rehydrateStart, registerStart);
    assert(
      !rehydrateFn.includes("nativeTokenRequestInit") && !rehydrateFn.includes("fetch("),
      "bridge rehydrate does not POST"
    );
  }
  assert(!/\blocalStorage\b/.test(bridge) && !/\bsessionStorage\b/.test(bridge), "no web storage");
  assert(!bridge.includes("Preferences"), "no Capacitor Preferences token persist");
  assert(card.includes("restoreNativePushUiState"), "card refresh uses passive restore");
  assert(card.includes("rehydrateNativePushToken"), "card refresh rehydrates token");
  const enableStart = card.indexOf("async function onEnable");
  const disableStart = card.indexOf("async function onDisable");
  const refreshStart = card.indexOf("const refresh = useCallback");
  const enableFn = card.slice(enableStart, disableStart);
  const refreshFn = card.slice(refreshStart, enableStart);
  assert(enableFn.includes("nativeTokenRequestInit"), "C: 알림 받기 still POSTs");
  assert(!refreshFn.includes("nativeTokenRequestInit"), "refresh/restore never POSTs");
}

async function testRestoreCases() {
  console.log("== restart restore A/B ==");
  const posts: string[] = [];
  const enabled = await restoreNativePushUiState({
    pluginAvailable: true,
    permission: "granted",
    rehydrateToken: async () => "device-token",
    getRegistered: async () => true,
  });
  assert(enabled.tokenReady === true, "A: token ready after rehydrate");
  assert(enabled.serverRegistered === true, "A: granted + enabled token → registered");
  assert(enabled.posted === false, "A: restore does not POST");

  const disabled = await restoreNativePushUiState({
    pluginAvailable: true,
    permission: "granted",
    rehydrateToken: async () => "device-token",
    getRegistered: async () => false,
  });
  assert(disabled.tokenReady === true, "B: token ready after rehydrate");
  assert(disabled.serverRegistered === false, "B: enabled=false stays unregistered");
  assert(disabled.posted === false, "B: no auto POST after disable");
  assert(posts.length === 0, "B: no POST side effects");

  let rehydrated = 0;
  let got = 0;
  const skipped = await restoreNativePushUiState({
    pluginAvailable: true,
    permission: "prompt",
    rehydrateToken: async () => {
      rehydrated += 1;
      return "device-token";
    },
    getRegistered: async () => {
      got += 1;
      return true;
    },
  });
  assert(rehydrated === 0 && got === 0, "not granted → no rehydrate/GET");
  assert(skipped.serverRegistered === false && skipped.posted === false, "prompt stays unrestored");
}

console.log("== deep link ==");
assert(resolveNativePushOpenPath({ url: "/course-reports/9" }) === "/course-reports/9", "course report");
assert(resolveNativePushOpenPath({ url: "/board?date=2026-09-21" }) === "/board?date=2026-09-21", "board");
assert(resolveNativePushOpenPath({ url: "/notice/3" }) === "/notice/3", "notice");
assert(
  resolveNativePushOpenPath({ data: { url: "/course-reports/1" } }) === "/course-reports/1",
  "nested FCM data.url"
);
assert(resolveNativePushOpenPath({ url: "https://evil.example/" }) === null, "absolute rejected");
assert(resolveNativePushOpenPath({ url: "//evil" }) === null, "protocol-relative rejected");
let assigned = "";
assert(assignNativePushPath("/caddy", (h) => { assigned = h; }) === true, "assign ok");
assert(assigned === "/caddy", "assign path");
assert(assignNativePushPath(null, () => {}) === false, "null path skipped");

assert(
  buildNativePushDataPayload({
    title: "t",
    body: "b",
    url: "/board?date=2026-09-21",
  }).url === "/board?date=2026-09-21",
  "FCM data payload keeps board url"
);

console.log("== FCM send fail-closed ==");
assert(isFcmSendEnabled({} as NodeJS.ProcessEnv) === false, "send disabled by default");
assert(
  isFcmServerConfigured({} as NodeJS.ProcessEnv) === false,
  "no server creds by default"
);
async function main() {
  await testRestoreCases();
  assert(hasDevicePushTokenDelegate({}) === false, "missing delegate safe");
  const skipped = await deliverNativePushTokens(
    {} as never,
    [{ id: 1, userId: 1, token: "t", platform: "ANDROID" }],
    { title: "t", body: "b", url: "/caddy" }
  );
  assert(skipped.reason === "send_disabled", "no FCM_SEND_ENABLED → skip");
  assert(skipped.sent === 0, "skip sends 0");
  const loaded = await loadEnabledDevicePushTokens({} as never, [1, 2]);
  assert(loaded.length === 0, "no delegate → empty tokens");

  const mockSent: string[] = [];
  const sent = await deliverNativePushTokens(
    { devicePushToken: { update: async () => ({}) } } as never,
    [{ id: 1, userId: 9, token: "tok-a", platform: "ANDROID" }],
    { title: "t", body: "b", url: "/notice/1" },
    {
      sendFn: async (token, payload) => {
        mockSent.push(token);
        assert(payload.url === "/notice/1", "payload url forwarded");
        return "sent";
      },
    }
  );
  assert(sent.sent === 1 && mockSent.length === 1, "injected sendFn delivers once");

  const stale = { enabled: true, lastFailureAt: null as Date | null };
  const transient = { enabled: true, lastFailureAt: null as Date | null };
  const failDb = {
    devicePushToken: {
      findMany: async () => [],
      updateMany: async ({
        where,
        data,
      }: {
        where: { id: number };
        data: { enabled?: boolean; lastFailureAt?: Date };
      }) => {
        const row = where.id === 1 ? stale : transient;
        if (data.enabled === false) row.enabled = false;
        if (data.lastFailureAt) row.lastFailureAt = data.lastFailureAt;
        return { count: 1 };
      },
    },
  };
  await deliverNativePushTokens(
    failDb as never,
    [
      { id: 1, userId: 1, token: "stale", platform: "ANDROID" },
      { id: 2, userId: 1, token: "tmp", platform: "ANDROID" },
    ],
    { title: "t", body: "b", url: "/caddy" },
    {
      sendFn: async (token) => (token === "stale" ? "gone" : "failed"),
    }
  );
  assert(stale.enabled === false, "gone disables stale token");
  assert(transient.enabled === true, "failed keeps token enabled");

  console.log("== Kakao / Web Push files stay ==");
  assert(
    read("src/lib/kakaoNativeBridge.ts").includes("NATIVE_KAKAO_LOGIN_ENABLED"),
    "Kakao bridge untouched flag"
  );
  assert(read("src/lib/pushDelivery.ts").includes("deliverWebPushMappings"), "Web Push delivery remains");
  assert(read("prisma/schema.prisma").includes("model PushSubscription"), "PushSubscription remains");

  if (failed) {
    console.error(`\nFAILED ${failed} / ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

void main();
