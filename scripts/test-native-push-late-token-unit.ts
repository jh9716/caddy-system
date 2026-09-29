/**
 * Late FCM registration-event rebind race (no prod write, no send).
 * 실행: npm run test:native-push-late-token-unit
 */
import fs from "node:fs";
import path from "node:path";
import { upsertDevicePushToken } from "../src/lib/nativePushToken";
import {
  createNativePushRebindCoordinator,
  shouldRebindNativePushToken,
} from "../src/lib/nativePushRebind";
import {
  createNativePushTokenArrivalGate,
  resolveLogoutNativePushToken,
} from "../src/lib/nativePushTokenArrival";
import { restoreNativePushUiState } from "../src/lib/nativePushUi";

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

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
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
  section("gate: late arrival after bootstrap timeout");
  {
    const gate = createNativePushTokenArrivalGate();
    const missed = gate.wait(40);
    await delay(50);
    assert((await missed) === null, "bootstrap 40ms miss (stands in for >1.5s)");
    gate.remember("late-T");
    assert(gate.read() === "late-T", "late registration stores token");
    assert((await gate.wait(10)) === "late-T", "later waiters see arrived token");
  }

  section("gate: event during wait resolves early");
  {
    const gate = createNativePushTokenArrivalGate();
    const pending = gate.wait(400);
    await delay(20);
    gate.remember("quick-T");
    assert((await pending) === "quick-T", "waiter unblocks on registration event");
  }

  section("A→logout→B: token arrives after 1.5s-equivalent miss");
  {
    const rows: TokenRow[] = [];
    const db = mockTokenDb(rows) as never;
    const token = "same-fcm-T";
    await upsertDevicePushToken(db, { userId: 1, token, platform: "ANDROID" });
    assert(rows[0].enabled === true, "A enabled");

    rows[0].enabled = false;
    const coordinator = createNativePushRebindCoordinator();
    coordinator.reset();

    const gate = createNativePushTokenArrivalGate();
    const bootstrapMiss = await gate.wait(30);
    assert(bootstrapMiss === null, "B bootstrap polling miss");

    let posts = 0;
    gate.remember(token);
    const late = await coordinator.rebind({
      pluginAvailable: true,
      permission: "granted",
      token: gate.read(),
      getRegistered: async () => "unregistered",
      postToken: async (next) => {
        posts += 1;
        await upsertDevicePushToken(db, {
          userId: 2,
          token: next,
          platform: "ANDROID",
        });
        return true;
      },
    });
    assert(late.posted === true, "late event POSTs to B session");
    assert(posts === 1, "exactly one POST");
    assert(rows.find((r) => r.userId === 1)?.enabled === false, "A disabled");
    assert(rows.find((r) => r.userId === 2)?.enabled === true, "B enabled");
  }

  section("bootstrap + registration event concurrent → POST 1");
  {
    const coordinator = createNativePushRebindCoordinator();
    let posts = 0;
    const postToken = async () => {
      posts += 1;
      await delay(20);
      return true;
    };
    const input = {
      pluginAvailable: true as const,
      permission: "granted" as const,
      token: "T",
      getRegistered: async () => "unregistered" as const,
      postToken,
    };
    const [a, b] = await Promise.all([
      coordinator.rebind(input),
      coordinator.rebind(input),
    ]);
    assert(a.posted === true || b.posted === true, "one of the callers posted");
    assert(posts === 1, "in-flight guard collapses to one POST");
    const again = await coordinator.rebind(input);
    assert(again.posted === false && posts === 1, "same heap already rebound skips");
  }

  section("same-user restart already registered → POST 0");
  {
    const coordinator = createNativePushRebindCoordinator();
    let posts = 0;
    const restored = await restoreNativePushUiState({
      pluginAvailable: true,
      permission: "granted",
      rehydrateToken: async () => "T",
      getRegistered: async () => true,
    });
    assert(restored.posted === false, "#186 restore still GET-only");
    const session = await coordinator.rebind({
      pluginAvailable: true,
      permission: "granted",
      token: "T",
      getRegistered: async () => "registered",
      postToken: async () => {
        posts += 1;
        return true;
      },
    });
    assert(session.posted === false && posts === 0, "already enabled → no POST");
  }

  section("denied / prompt / web → POST 0");
  {
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "denied",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === false,
      "denied no rebind"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: true,
        permission: "prompt",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === false,
      "prompt no rebind / no popup"
    );
    assert(
      shouldRebindNativePushToken({
        pluginAvailable: false,
        permission: "granted",
        token: "T",
        serverRegistered: false,
        alreadyReboundToken: null,
      }) === false,
      "web/PWA no rebind"
    );
  }

  section("logout delayed token within timeout");
  {
    const gate = createNativePushTokenArrivalGate();
    const pending = resolveLogoutNativePushToken({
      memoryToken: null,
      acquireIfGranted: () => gate.wait(120),
    });
    await delay(25);
    gate.remember("logout-T");
    assert((await pending) === "logout-T", "logout waits on shared gate, not poll-only");
  }

  section("logout timeout fail-soft, no hang");
  {
    const started = Date.now();
    const token = await resolveLogoutNativePushToken({
      memoryToken: null,
      acquireIfGranted: () => createNativePushTokenArrivalGate().wait(40),
    });
    const elapsed = Date.now() - started;
    assert(token === null, "timeout returns null");
    assert(elapsed < 200, "logout does not wait long after timeout");
  }

  section("logout memory token skips wait");
  {
    let acquired = 0;
    const token = await resolveLogoutNativePushToken({
      memoryToken: "mem-T",
      acquireIfGranted: async () => {
        acquired += 1;
        return "late";
      },
    });
    assert(token === "mem-T" && acquired === 0, "memory token used immediately");
  }

  section("source: late registration triggers rebind");
  {
    const bridge = read("src/lib/nativePushBridge.ts");
    const card = read("src/components/NativePushNotificationCard.tsx");
    const restore = read("src/lib/nativePushUi.ts");
    const upsert = read("src/lib/nativePushToken.ts");
    const notice = read("src/lib/noticePush.ts");
    const listener = bridge.slice(
      bridge.indexOf('addListener("registration"'),
      bridge.indexOf("registrationError")
    );
    assert(listener.includes("rememberNativePushToken"), "listener still stores token");
    assert(listener.includes("rebindNativePushTokenOnSession"), "late event triggers rebind");
    assert(bridge.includes("createNativePushTokenArrivalGate"), "shared token gate");
    assert(bridge.includes("resolveLogoutNativePushToken"), "logout uses shared acquire");
    assert(bridge.includes("createNativePushRebindCoordinator"), "shared POST coordinator");
    {
      const rebindStart = bridge.indexOf("export async function rebindNativePushTokenOnSession");
      const rehydrateStart = bridge.indexOf("export async function rehydrateNativePushToken");
      assert(
        !bridge.slice(rebindStart, rehydrateStart).includes("requestPermissions"),
        "rebind still no permission popup"
      );
      const registerStart = bridge.indexOf("export async function registerNativePushDevice");
      assert(
        !bridge.slice(rehydrateStart, registerStart).includes("fetch("),
        "rehydrate still no POST"
      );
    }
    const refreshStart = card.indexOf("const refresh = useCallback");
    const enableStart = card.indexOf("async function onEnable");
    assert(
      !card.slice(refreshStart, enableStart).includes("nativeTokenRequestInit"),
      "card restore still no POST"
    );
    assert(card.slice(enableStart).includes("nativeTokenRequestInit"), "알림 ON still POSTs");
    assert(restore.includes("Never POSTs"), "#186 restore comment");
    assert(upsert.includes("disableDevicePushTokensForOtherUsers"), "#196 upsert kept");
    assert(!notice.includes("createNativePushTokenArrivalGate"), "notice send untouched");
  }

  console.log(`\nDONE: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
