/**
 * Notice web/native channel overlap. No live push, no production DB.
 * 실행: npm run test:notice-push-channel-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  filterNoticeWebPushForNativeOverlap,
  isAndroidWebPushSubscription,
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

function sub(
  id: number,
  userId: number,
  extra?: { platform?: string | null; userAgent?: string | null; endpoint?: string }
) {
  return {
    id,
    userId,
    endpoint: extra?.endpoint ?? `https://push.example/${id}`,
    p256dh: "p",
    auth: "a",
    platform: extra?.platform ?? null,
    userAgent: extra?.userAgent ?? null,
  };
}

section("android web classification");
{
  assert(isAndroidWebPushSubscription({ platform: "android" }) === true, "platform android");
  assert(isAndroidWebPushSubscription({ platform: "ANDROID" }) === true, "platform ANDROID");
  assert(isAndroidWebPushSubscription({ platform: "desktop" }) === false, "platform desktop");
  assert(isAndroidWebPushSubscription({ platform: "ios" }) === false, "platform ios");
  assert(
    isAndroidWebPushSubscription({
      platform: null,
      userAgent: "Mozilla/5.0 (Linux; Android 14; SM-S) SamsungBrowser/26.0",
    }) === true,
    "UA Samsung Android when platform missing"
  );
  assert(
    isAndroidWebPushSubscription({
      platform: "desktop",
      userAgent: "Mozilla/5.0 (Linux; Android 14) Chrome/120.0.0.0",
    }) === false,
    "explicit desktop wins over Android UA"
  );
  assert(
    isAndroidWebPushSubscription({ platform: null, userAgent: null }) === false,
    "unknown mapping is not treated as android"
  );
}

section("filter keeps browser-only and PC web");
{
  const androidWeb = sub(1, 10, { platform: "android" });
  const desktopWeb = sub(2, 10, { platform: "desktop" });
  const otherUserAndroid = sub(3, 20, { platform: "android" });
  const unknown = sub(4, 10, { platform: null, userAgent: null });

  const none = filterNoticeWebPushForNativeOverlap(
    [androidWeb, desktopWeb, otherUserAndroid],
    []
  );
  assert(none.length === 3, "no native → keep all web");

  const filtered = filterNoticeWebPushForNativeOverlap(
    [androidWeb, desktopWeb, otherUserAndroid, unknown],
    [10]
  );
  assert(
    filtered.map((s) => s.id).join(",") === "2,3,4",
    "native success: drop that user's android web only"
  );
  assert(
    filtered.some((s) => s.id === 2),
    "same user desktop web kept (PC + app)"
  );
  assert(
    filtered.some((s) => s.id === 3),
    "other user android web kept (no native on that user)"
  );
  assert(
    filtered.some((s) => s.id === 4),
    "unknown platform/UA kept (no physical-device id)"
  );
}

section("select uses native success, not token presence");
{
  const androidWeb = sub(1, 10, { platform: "android" });
  const desktopWeb = sub(2, 10, { platform: "desktop" });
  const kept = selectNoticeWebPushMappings([androidWeb, desktopWeb], []);
  assert(kept.length === 2, "no native success → keep android web fallback");
  const ready = selectNoticeWebPushMappings([androidWeb, desktopWeb], [10]);
  assert(ready.length === 1 && ready[0].id === 2, "native success skips android web only");
  const otherUser = selectNoticeWebPushMappings([androidWeb], [99]);
  assert(otherUser.length === 1, "other user's success does not drop this android web");
}

section("source: notice send uses helper, does not blank all web");
{
  const core = read("src/lib/noticePush.ts");
  const helper = read("src/lib/noticePushChannel.ts");
  assert(core.includes("selectNoticeWebPushMappings"), "sendNoticePush uses helper");
  assert(core.includes("sentUserIds"), "sendNoticePush reads native success users");
  assert(
    core.lastIndexOf("await deliverNativePushTokens") <
      core.lastIndexOf("await deliverWebPushMappings"),
    "native first, then web fallback"
  );
  assert(helper.includes("isAndroidWebPushSubscription"), "classifies android web");
  assert(
    helper.includes("Do not disable every web mapping"),
    "documents no user-wide web disable"
  );
  assert(
    helper.includes("actual native delivery success"),
    "documents success-based dedupe"
  );
  assert(
    /filterNoticeWebPushForNativeOverlap/.test(helper),
    "overlap filter exists"
  );
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
