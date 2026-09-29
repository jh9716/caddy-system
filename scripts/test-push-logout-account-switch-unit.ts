/**
 * B2–B4: account-switch native token + logout web/native cleanup (no prod write)
 * 실행: npm run test:push-logout-account-switch-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  disableDevicePushTokensForOtherUsers,
  upsertDevicePushToken,
} from "../src/lib/nativePushToken";
import {
  disableAllPushSubscriptionsForUser,
  disablePushSubscriptionForUserEndpoint,
} from "../src/lib/pushSubscriptionStore";
import { webPushLogoutDisableInit } from "../src/lib/webPushLogoutHttp";
import { nativeTokenDisableInit } from "../src/lib/nativePushHttp";

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

type TokenRow = {
  userId: number;
  token: string;
  platform: "ANDROID";
  enabled: boolean;
};

function mockTokenDb(rows: TokenRow[]) {
  return {
    devicePushToken: {
      async updateMany(args: {
        where: { token: string; enabled: boolean; userId: { not: number } };
        data: { enabled: boolean };
      }) {
        let count = 0;
        for (const row of rows) {
          if (
            row.token === args.where.token &&
            row.enabled === true &&
            row.userId !== args.where.userId.not
          ) {
            row.enabled = args.data.enabled;
            count += 1;
          }
        }
        return { count };
      },
      async upsert(args: {
        where: { userId_token: { userId: number; token: string } };
        create: TokenRow;
        update: { enabled: boolean; platform: "ANDROID" };
      }) {
        const found = rows.find(
          (row) =>
            row.userId === args.where.userId_token.userId &&
            row.token === args.where.userId_token.token
        );
        if (found) {
          found.enabled = args.update.enabled;
          found.platform = args.update.platform;
          return found;
        }
        rows.push({ ...args.create });
        return args.create;
      },
    },
  };
}

type SubRow = { userId: number; endpoint: string; enabled: boolean };

function mockSubDb(rows: SubRow[]) {
  return {
    pushSubscription: {
      async updateMany(args: {
        where: { userId: number; endpoint?: string; enabled: boolean };
        data: { enabled: boolean };
      }) {
        let count = 0;
        for (const row of rows) {
          if (row.userId !== args.where.userId || row.enabled !== true) continue;
          if (args.where.endpoint != null && row.endpoint !== args.where.endpoint) {
            continue;
          }
          row.enabled = args.data.enabled;
          count += 1;
        }
        return { count };
      },
    },
  };
}

async function main() {
  section("B2: same token account switch");
  {
    const rows: TokenRow[] = [];
    const db = mockTokenDb(rows) as never;
    await upsertDevicePushToken(db, {
      userId: 1,
      token: "same-fcm-token",
      platform: "ANDROID",
    });
    assert(rows.length === 1 && rows[0].userId === 1 && rows[0].enabled, "A registered enabled");

    await upsertDevicePushToken(db, {
      userId: 2,
      token: "same-fcm-token",
      platform: "ANDROID",
    });
    const a = rows.find((r) => r.userId === 1);
    const b = rows.find((r) => r.userId === 2);
    assert(a?.enabled === false, "A token row disabled after B registers");
    assert(b?.enabled === true, "B token row enabled");
    assert(rows.filter((r) => r.enabled).length === 1, "only one enabled row for token");

    const n = await disableDevicePushTokensForOtherUsers(db, {
      userId: 2,
      token: "same-fcm-token",
    });
    assert(n === 0, "B re-register does not disable self");
  }

  section("B2 restore: current user upsert re-enables own row");
  {
    const rows: TokenRow[] = [
      { userId: 1, token: "tok", platform: "ANDROID", enabled: false },
    ];
    const db = mockTokenDb(rows) as never;
    await upsertDevicePushToken(db, {
      userId: 1,
      token: "tok",
      platform: "ANDROID",
    });
    assert(rows[0].enabled === true, "same user upsert restores enabled");
  }

  section("B3: current endpoint disable, other devices kept");
  {
    const rows: SubRow[] = [
      { userId: 9, endpoint: "https://push.example/a", enabled: true },
      { userId: 9, endpoint: "https://push.example/other-device", enabled: true },
      { userId: 8, endpoint: "https://push.example/other-user", enabled: true },
    ];
    const db = mockSubDb(rows) as never;
    const n = await disablePushSubscriptionForUserEndpoint(
      db,
      9,
      "https://push.example/a"
    );
    assert(n === 1, "one current endpoint disabled");
    assert(rows[0].enabled === false, "current browser disabled");
    assert(rows[1].enabled === true, "other device of same user kept");
    assert(rows[2].enabled === true, "other user kept");

    const all = await disableAllPushSubscriptionsForUser(db, 9);
    assert(all === 1, "logout-all disables remaining user 9 row");
    assert(rows[1].enabled === false, "user 9 other device disabled on logout-all");
    assert(rows[2].enabled === true, "other user still enabled after logout-all");
  }

  section("B3/B4 source: logout helpers reused");
  {
    const logoutBtn = read("src/components/LogoutButton.tsx");
    const changePw = read("src/app/change-password/ChangePasswordClient.tsx");
    const client = read("src/lib/logoutClient.ts");
    const logoutAll = read("src/app/api/auth/logout-all/route.ts");
    const subRoute = read("src/app/api/push/subscription/route.ts");
    const nativeRoute = read("src/app/api/push/native-token/route.ts");
    const cookieLogout = read("src/app/api/logout/route.ts");
    const notice = read("src/lib/noticePush.ts");
    const board = read("src/lib/boardPush.ts");
    const report = read("src/lib/courseReportPush.ts");

    assert(client.includes("deactivateNativePushOnLogout"), "shared helper native");
    assert(client.includes("deactivateWebPushOnLogout"), "shared helper web");
    assert(logoutBtn.includes("logoutCurrentDevice"), "LogoutButton uses shared helper");
    assert(logoutBtn.includes("logoutAllDevices"), "LogoutButton logout-all uses helper");
    assert(changePw.includes("logoutCurrentDevice"), "change-password logout reuses helper");
    assert(!changePw.includes("deactivateNativePushOnLogout("), "change-password no duplicate native call");
    assert(logoutAll.includes("disableAllPushSubscriptionsForUser"), "logout-all disables web push");
    assert(logoutAll.includes("disableAllDevicePushTokensForUser"), "logout-all still disables native");
    assert(subRoute.includes('rec.scope === "all"'), "subscription DELETE scope=all");
    assert(
      subRoute.includes("disablePushSubscriptionForUserEndpoint"),
      "subscription DELETE scope=current disables this endpoint"
    );
    assert(subRoute.includes("deletePushSubscriptionForUser"), "card unsubscribe still deletes");
    assert(nativeRoute.includes("upsertDevicePushToken"), "native POST still upserts");
    assert(
      read("src/lib/nativePushToken.ts").includes("disableDevicePushTokensForOtherUsers"),
      "upsert disables other users"
    );
    assert(cookieLogout.includes("clearSessionCookies"), "cookie logout kept");
    assert(!cookieLogout.includes("sessionVersion"), "cookie logout still no sv bump");
    assert(!notice.includes("disableDevicePushTokensForOtherUsers"), "notice send untouched");
    assert(!board.includes("disableAllPushSubscriptionsForUser"), "board send untouched");
    assert(!report.includes("disableAllPushSubscriptionsForUser"), "course-report send untouched");
    assert(
      read("src/lib/nativePushBridge.ts").includes("rehydrateNativePushToken"),
      "restart rehydrate kept"
    );
  }

  section("logout HTTP bodies stay device-scoped");
  {
    const current = webPushLogoutDisableInit("https://push.example/this", "current");
    assert(current.method === "DELETE", "web current DELETE");
    assert(JSON.parse(current.body).endpoint === "https://push.example/this", "web current endpoint");
    assert(JSON.parse(current.body).scope === "current", "web current is this endpoint only");
    const all = webPushLogoutDisableInit(null, "all");
    assert(JSON.parse(all.body).scope === "all", "web all uses scope");
    const native = nativeTokenDisableInit("tok", "current");
    assert(JSON.parse(native.body).token === "tok", "native current token");
    assert(JSON.parse(nativeTokenDisableInit("tok", "all").body).scope === "all", "native all scope");
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
