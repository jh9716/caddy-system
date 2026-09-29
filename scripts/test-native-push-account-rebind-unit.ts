/**
 * Account-switch native token rebind (no prod write, no send).
 * 실행: npm run test:native-push-account-rebind-unit
 */
import fs from "node:fs";
import path from "node:path";
import { upsertDevicePushToken } from "../src/lib/nativePushToken";
import {
  runNativePushSessionRebind,
  shouldRebindNativePushToken,
} from "../src/lib/nativePushRebind";
import { restoreNativePushUiState } from "../src/lib/nativePushUi";
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

async function main() {
  section("shouldRebind gates");
  {
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "granted",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === true,
      "granted + token + not registered → rebind"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "granted",
        token: "T",
        serverRegistered: true,
        alreadyReboundToken: null,
      }) === false,
      "already registered → no rebind"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "prompt",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === false,
      "prompt → no rebind (no permission popup)"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "granted",
        token: null,
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === false,
      "no token → no rebind"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: false,
        permission: "granted",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === false,
      "web → no rebind"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "granted",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: "T",
      }) === false,
      "same heap already rebound → no second POST"
    );
  }

  section("A logout → B login same token T rebind");
  {
    const rows: TokenRow[] = [];
    const db = mockTokenDb(rows) as never;
    const token = "same-fcm-T";
    await upsertDevicePushToken(db, { userId: 1, token, platform: "ANDROID" });
    assert(rows[0].enabled === true && rows[0].userId === 1, "A registered");

    rows[0].enabled = false;
    assert(rows[0].enabled === false, "A logout disables own row");

    const posts: string[] = [];
    const bSession = await runNativePushSessionRebind({
      pluginAvailable: true,
      permission: "granted",
      token,
      alreadyReboundToken: null,
      getRegistered: async () => "unregistered",
      postToken: async (next) => {
        posts.push(next);
        await upsertDevicePushToken(db, {
          userId: 2,
          token: next,
          platform: "ANDROID",
        });
        return true;
      },
    });
    assert(bSession.posted === true, "B session POSTs same token");
    assert(posts.length === 1 && posts[0] === token, "one POST of T");
    assert(rows.find((r) => r.userId === 1)?.enabled === false, "A disabled after B rebind");
    assert(rows.find((r) => r.userId === 2)?.enabled === true, "B enabled");
    assert(rows.filter((r) => r.enabled).length === 1, "only B enabled");

    const second = await runNativePushSessionRebind({
      pluginAvailable: true,
      permission: "granted",
      token,
      alreadyReboundToken: token,
      getRegistered: async () => "registered",
      postToken: async () => {
        posts.push("extra");
        return true;
      },
    });
    assert(second.posted === false, "second rebind in same heap skipped");
    assert(posts.length === 1, "no extra POST");
  }

  section("same-user re-login rebinds disabled row");
  {
    const rows: TokenRow[] = [
      { userId: 7, token: "T7", platform: "ANDROID", enabled: false },
    ];
    const db = mockTokenDb(rows) as never;
    const again = await runNativePushSessionRebind({
      pluginAvailable: true,
      permission: "granted",
      token: "T7",
      alreadyReboundToken: null,
      getRegistered: async () => "unregistered",
      postToken: async (next) => {
        await upsertDevicePushToken(db, {
          userId: 7,
          token: next,
          platform: "ANDROID",
        });
        return true;
      },
    });
    assert(again.posted === true, "same user re-login POSTs");
    assert(rows[0].enabled === true, "same user row re-enabled");
  }

  section("#186 restart restore still no POST");
  {
    const posts: string[] = [];
    const restored = await restoreNativePushUiState({
      pluginAvailable: true,
      permission: "granted",
      rehydrateToken: async () => "T",
      getRegistered: async () => true,
    });
    assert(restored.posted === false, "restore posted false");
    assert(restored.serverRegistered === true, "restore GET registered");
    assert(posts.length === 0, "restore has no POST hook");

    const skipped = await runNativePushSessionRebind({
      pluginAvailable: true,
      permission: "granted",
      token: "T",
      alreadyReboundToken: null,
      getRegistered: async () => "registered",
      postToken: async () => {
        posts.push("nope");
        return true;
      },
    });
    assert(skipped.posted === false, "already registered session skips POST");
    assert(posts.length === 0, "restart same user no POST");
  }

  section("알림 OFF/ON still uses explicit POST");
  {
    const card = read("src/components/NativePushNotificationCard.tsx");
    const enableStart = card.indexOf("async function onEnable");
    const disableStart = card.indexOf("async function onDisable");
    const refreshStart = card.indexOf("const refresh = useCallback");
    const enableFn = card.slice(enableStart, disableStart);
    const refreshFn = card.slice(refreshStart, enableStart);
    assert(enableFn.includes("nativeTokenRequestInit"), "ON still POSTs");
    assert(enableFn.includes("rehydrateNativePushToken"), "ON retries OS token");
    assert(card.slice(disableStart).includes("nativeTokenDisableInit"), "OFF still DELETE");
    assert(!refreshFn.includes("nativeTokenRequestInit"), "card refresh still no POST");
    assert(!refreshFn.includes("runNativePushSessionRebind"), "card refresh not session rebind");
  }

  section("source: login has no token POST, bootstrap rebinds");
  {
    const login = read("src/app/login/LoginClient.tsx");
    const bootstrap = read("src/components/NativePushBootstrap.tsx");
    const bridge = read("src/lib/nativePushBridge.ts");
    const restore = read("src/lib/nativePushUi.ts");
    const notice = read("src/lib/noticePush.ts");
    const board = read("src/lib/boardPush.ts");
    const report = read("src/lib/courseReportPush.ts");
    assert(!login.includes("native-token"), "LoginClient does not POST native token");
    assert(!login.includes("rebindNativePushTokenOnSession"), "login stays redirect-only");
    assert(bootstrap.includes("rebindNativePushTokenOnSession"), "layout bootstrap rebinds");
    assert(bootstrap.includes("bindNativePushListeners"), "tap listeners kept");
    assert(bridge.includes("rehydrateNativePushToken"), "rehydrate kept");
    {
      const rehydrateStart = bridge.indexOf("export async function rehydrateNativePushToken");
      const registerStart = bridge.indexOf("export async function registerNativePushDevice");
      const rehydrateFn = bridge.slice(rehydrateStart, registerStart);
      assert(
        !rehydrateFn.includes("nativeTokenRequestInit") && !rehydrateFn.includes("fetch("),
        "rehydrate still no POST"
      );
    }
    assert(
      !bridge
        .slice(
          bridge.indexOf("export async function rebindNativePushTokenOnSession"),
          bridge.indexOf("export async function rehydrateNativePushToken")
        )
        .includes("requestPermissions"),
      "rebind does not request permission"
    );
    assert(restore.includes("Never POSTs"), "restore comment kept");
    assert(!notice.includes("rebindNativePushTokenOnSession"), "notice send untouched");
    assert(!board.includes("rebindNativePushTokenOnSession"), "board send untouched");
    assert(!report.includes("rebindNativePushTokenOnSession"), "course-report send untouched");
    const body = JSON.parse(nativeTokenRequestInit("T").body);
    assert(body.token === "T" && body.platform === "ANDROID", "POST body still token+platform");
    assert(body.userId == null, "POST still has no client userId");
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
