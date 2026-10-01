/**
 * QA C5: notice push preview uses the same native/web overlap as send.
 * Preview never sends. local/mock only.
 * 실행: npm run test:notice-preview-channel-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  nativeUserIdsFromTokens,
  planNoticePushPreviewChannels,
  selectNoticeWebPushMappings,
} from "../src/lib/noticePushChannel";

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

function web(
  id: number,
  userId: number,
  extra?: { platform?: string | null; userAgent?: string | null }
) {
  return {
    id,
    userId,
    endpoint: `https://push.example/${id}`,
    p256dh: "p",
    auth: "a",
    platform: extra?.platform ?? null,
    userAgent: extra?.userAgent ?? null,
  };
}

function token(userId: number, n = 1) {
  return Array.from({ length: n }, (_, i) => ({ userId, token: `${userId}-${i}` }));
}

section("A web only");
{
  const planned = planNoticePushPreviewChannels({
    eligibleUsers: 1,
    webMappings: [web(1, 10, { platform: "android" })],
    nativeTokens: [],
  });
  assert(planned.counts.nativeTokens === 0, "A native tokens 0");
  assert(planned.counts.webSubscriptions === 1, "A web kept");
  assert(planned.counts.subscribedUsers === 1, "A reachable 1");
  assert(planned.counts.subscriptions === 1, "A devices 1");
}

section("B native only");
{
  const planned = planNoticePushPreviewChannels({
    eligibleUsers: 1,
    webMappings: [],
    nativeTokens: token(20),
  });
  assert(planned.counts.nativeTokens === 1, "B native token 1");
  assert(planned.counts.nativeUsers === 1, "B native user 1");
  assert(planned.counts.webSubscriptions === 0, "B web 0");
  assert(planned.counts.subscribedUsers === 1, "B native-only is reachable, not 알림 불가");
  assert(planned.counts.noSubscription === 0, "B noSubscription 0");
}

section("C native + Android web overlap");
{
  const planned = planNoticePushPreviewChannels({
    eligibleUsers: 1,
    webMappings: [web(1, 30, { platform: "android" })],
    nativeTokens: token(30),
  });
  assert(
    planned.expectedNativeUserIds.join(",") ===
      nativeUserIdsFromTokens(token(30)).join(","),
    "C expected native users reuse nativeUserIdsFromTokens"
  );
  assert(
    planned.expectedWebMappings.length ===
      selectNoticeWebPushMappings([web(1, 30, { platform: "android" })], [30])
        .length,
    "C expected web reuses selectNoticeWebPushMappings"
  );
  assert(planned.counts.nativeTokens === 1, "C native 1");
  assert(planned.counts.webSubscriptions === 0, "C android web excluded");
  assert(planned.counts.subscribedUsers === 1, "C user counted once");
  assert(planned.counts.subscriptions === 1, "C devices = native only");
}

section("D native + desktop/iOS web");
{
  const mappings = [
    web(1, 40, { platform: "desktop" }),
    web(2, 40, { platform: "ios" }),
    web(3, 40, { platform: "android" }),
  ];
  const planned = planNoticePushPreviewChannels({
    eligibleUsers: 1,
    webMappings: mappings,
    nativeTokens: token(40),
  });
  assert(planned.counts.nativeTokens === 1, "D native 1");
  assert(planned.counts.webSubscriptions === 2, "D desktop/iOS web kept");
  assert(
    planned.expectedWebMappings.map((s) => s.platform).join(",") === "desktop,ios",
    "D remaining web is desktop+ios"
  );
  assert(planned.counts.subscriptions === 3, "D devices = 1 native + 2 web");
}

section("E multi-token / multi-subscription");
{
  const mappings = [
    web(1, 50, { platform: "desktop" }),
    web(2, 50, { platform: "desktop" }),
  ];
  const planned = planNoticePushPreviewChannels({
    eligibleUsers: 1,
    webMappings: mappings,
    nativeTokens: token(50, 3),
  });
  assert(planned.counts.nativeTokens === 3, "E native token count 3");
  assert(planned.counts.nativeUsers === 1, "E native user 1");
  assert(planned.counts.webSubscriptions === 2, "E desktop webs kept");
  assert(planned.counts.webUsers === 1, "E web user 1");
  assert(planned.counts.subscribedUsers === 1, "E reachable users 1");
  assert(planned.counts.subscriptions === 5, "E devices 3 native + 2 web");
}

section("F preview assumes native success, not fallback");
{
  const planned = planNoticePushPreviewChannels({
    eligibleUsers: 1,
    webMappings: [web(1, 60, { platform: "android" })],
    nativeTokens: token(60),
  });
  assert(planned.counts.webSubscriptions === 0, "F preview excludes android web");
  const sendFallback = selectNoticeWebPushMappings(
    [web(1, 60, { platform: "android" })],
    []
  );
  assert(sendFallback.length === 1, "F actual send after native fail keeps android web");
}

section("source: preview reuses send helpers and does not send");
{
  const previewLib = read("src/lib/noticePush.ts");
  const helper = read("src/lib/noticePushChannel.ts");
  const card = read("src/components/notice/NoticePushNotifyCard.tsx");
  const route = read("src/app/api/push/notice-preview/route.ts");
  const previewFn = previewLib.split("export async function previewNoticePush")[1]?.split(
    "export async function sendNoticePush"
  )[0] || "";
  const sendFn = previewLib.split("export async function sendNoticePush")[1] || "";
  assert(previewFn.includes("planNoticePushPreviewChannels"), "preview uses planner");
  assert(previewFn.includes("loadEnabledDevicePushTokens"), "preview reads native inventory");
  assert(
    !previewFn.includes("deliverNativePushTokens") &&
      !previewFn.includes("deliverWebPushMappings"),
    "preview send function 호출 0"
  );
  assert(!previewFn.includes("enabled: false"), "preview does not disable tokens");
  assert(
    helper.includes("selectWebPushMappingsAfterNativeSuccess") &&
      helper.includes("nativeUserIdsFromTokens"),
    "planner imports C1 overlap helpers"
  );
  assert(
    sendFn.includes("selectNoticeWebPushMappings") &&
      sendFn.includes("sentUserIds") &&
      sendFn.includes("deliverNativePushTokens"),
    "G C1 send path still native-first + success overlap"
  );
  assert(
    sendFn.lastIndexOf("await deliverNativePushTokens") <
      sendFn.lastIndexOf("await deliverWebPushMappings"),
    "G send still native then web"
  );
  assert(route.includes("previewNoticePush"), "preview route stays preview-only");
  assert(!route.includes("sendNoticePush"), "preview route does not send");
  assert(card.includes("Native 예상"), "UI shows native expected");
  assert(card.includes("Web 예상"), "UI shows web expected");
  assert(card.includes("Web fallback"), "UI notes fallback may differ");
}

console.log(`\nDONE: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
