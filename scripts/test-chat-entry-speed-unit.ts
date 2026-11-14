/**
 * Chat entry speed: same-tab list paint, last-opened prewarm hint, park wait,
 * shell warm/token prefetch. No Worker/protocol/DB.
 * 실행: npm run test:chat-entry-speed-unit
 */
import { readFileSync } from "node:fs";
import {
  modelChatRevisitClickToShown,
  shouldPaintCachedRoomsNow,
  shouldPrefetchChatToken,
  shouldWarmChatWorkerOnShell,
  type ChatEntryHopMs,
} from "../src/lib/chatEntrySpeed";
import { shouldAwaitParkRuntimeCheck } from "../src/lib/chatWsReuse";
import {
  pickChatPrewarmRoom,
  shouldStartChatPrewarm,
} from "../src/lib/chatPrewarm";
import {
  clearChatFastEntryCache,
  prefetchChatTokenIfNeeded,
  readLastOpenedChatRoom,
  rememberChatToken,
  rememberLastOpenedChatRoom,
} from "../src/lib/chatFastEntry";
import {
  enableChatEntryTimingFromSearch,
  isChatEntryQueryEnabled,
  isChatEntryTimingEnabledFor,
  resetChatEntryTimingForTests,
} from "../src/lib/chatEntryTiming";
import { applyChatSessionResetReason, clearChatSessionEnded } from "../src/lib/chatSessionReset";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL", msg);
  }
}

const rooms = [{ roomId: "all" }, { roomId: "room_aaa" }, { roomId: "dm_1_2" }];

console.log("== paint / prefetch / park ==");
assert(
  shouldPaintCachedRoomsNow({ sessionEnded: false, hasCachedToken: true, cachedRoomCount: 3 }) === true,
  "cached token+rooms may paint"
);
assert(
  shouldPaintCachedRoomsNow({ sessionEnded: true, hasCachedToken: true, cachedRoomCount: 3 }) === false,
  "ended session does not paint cache"
);
assert(
  shouldPaintCachedRoomsNow({ sessionEnded: false, hasCachedToken: false, cachedRoomCount: 3 }) === false,
  "no token does not paint"
);
assert(
  shouldPaintCachedRoomsNow({ sessionEnded: false, hasCachedToken: true, cachedRoomCount: 0 }) === false,
  "empty cache does not paint"
);
assert(shouldPrefetchChatToken({ pathname: "/", hasReusableToken: false }) === true, "home prefetches token");
assert(shouldPrefetchChatToken({ pathname: "/chat", hasReusableToken: false }) === false, "on /chat skip prefetch");
assert(shouldPrefetchChatToken({ pathname: "/", hasReusableToken: true }) === false, "reusable skips prefetch");
assert(shouldWarmChatWorkerOnShell() === true, "logged-in shell warms Worker origin");
assert(shouldAwaitParkRuntimeCheck(true) === false, "known-on runtime does not delay park");
assert(shouldAwaitParkRuntimeCheck(false) === true, "unknown runtime still awaits kill switch");

console.log("== last-opened hint prewarm ==");
assert(
  pickChatPrewarmRoom({ directorySnapshotReady: false, sessionEnded: false, rooms }) === null,
  "cached list without last-opened does not pick rooms[0]"
);
assert(
  pickChatPrewarmRoom({
    directorySnapshotReady: false,
    sessionEnded: false,
    rooms,
    lastOpenedRoomId: "dm_1_2",
  }) === "dm_1_2",
  "cached last-opened may prewarm before snapshot"
);
assert(
  pickChatPrewarmRoom({
    directorySnapshotReady: false,
    sessionEnded: false,
    rooms,
    lastOpenedRoomId: "gone",
  }) === null,
  "unknown last-opened does not pick first room from cache"
);
assert(
  shouldStartChatPrewarm({
    viewIsList: true,
    directorySnapshotReady: false,
    sessionEnded: false,
    hasTarget: true,
    currentRoomId: null,
    inflightOrReady: false,
  }) === true,
  "list + last-opened hint starts before snapshot"
);

console.log("== lastOpened memory ==");
clearChatSessionEnded();
clearChatFastEntryCache();
rememberLastOpenedChatRoom("dm_8_40");
assert(readLastOpenedChatRoom() === "dm_8_40", "remembers last opened");
rememberChatToken({ token: "t", exp: Math.floor(Date.now() / 1000) + 1800, user: { userId: 2 } });
assert(readLastOpenedChatRoom() === "dm_8_40", "same user keeps last opened");
rememberChatToken({ token: "u", exp: Math.floor(Date.now() / 1000) + 1800, user: { userId: 9 } });
assert(readLastOpenedChatRoom() === null, "user switch drops last opened");
rememberLastOpenedChatRoom("all");
applyChatSessionResetReason("logout");
assert(readLastOpenedChatRoom() === null, "logout drops last opened");
clearChatSessionEnded();
clearChatFastEntryCache();

console.log("== token prefetch ==");
async function testPrefetch() {
  let called = 0;
  const okFetch = async () => {
    called += 1;
    return {
      ok: true,
      json: async () => ({
        ok: true,
        token: "tok",
        exp: Math.floor(Date.now() / 1000) + 1800,
        user: { userId: 1, displayName: "A", role: "caddy", team: "1" },
      }),
    } as Response;
  };
  assert((await prefetchChatTokenIfNeeded(okFetch)) === true, "prefetch stores reusable token");
  assert(called === 1, "one POST");
  assert((await prefetchChatTokenIfNeeded(okFetch)) === false, "second prefetch skipped");
  assert(called === 1, "no extra POST when reusable");
  clearChatFastEntryCache();
}

console.log("== opt-in timing ==");
assert(isChatEntryQueryEnabled("?chatEntry=1") === true, "query on");
assert(isChatEntryQueryEnabled("chatEntry=1") === true, "bare query on");
assert(isChatEntryQueryEnabled("?room=all") === false, "other query off");
assert(isChatEntryTimingEnabledFor("production", "production") === false, "production default off");
resetChatEntryTimingForTests(false);
assert(enableChatEntryTimingFromSearch("?chatEntry=1") === true, "query enables marks");
resetChatEntryTimingForTests(null);

console.log("== revisit model (not production telemetry) ==");
const lte: ChatEntryHopMs = {
  tokenPost: 180,
  workerTls: 200,
  directoryRooms: 200,
  roomAuthorize: 350,
  historyFrame: 40,
};
const before = modelChatRevisitClickToShown({
  hops: lte,
  listDwellMs: 400,
  workerTlsWarmed: false,
  tokenCached: true,
  lastOpenedHintPrewarm: false,
  snapshotWaitMs: 200,
});
const after = modelChatRevisitClickToShown({
  hops: lte,
  listDwellMs: 400,
  workerTlsWarmed: true,
  tokenCached: true,
  lastOpenedHintPrewarm: true,
  snapshotWaitMs: 200,
});
assert(before.listPaintMs === 200, "before: list waits directory");
assert(after.listPaintMs === 0, "after: cached list is 0");
assert(after.clickToShownMs === 0, "after: 400ms dwell covers warmed prewarm");
assert(before.clickToShownMs > after.clickToShownMs, "model click→shown drops");
assert(before.clickToShownMs === 200 + 200 + 350 + 40 - 400, "before remainder is snapshot+tls+auth+hist − dwell");

console.log("== ChatClient / shell wiring / no 354-355 ==");
const chat = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
assert(chat.includes("useLayoutEffect"), "layout paint before first pixels");
assert(chat.includes("shouldPaintCachedRoomsNow"), "cache paint gated");
assert(chat.includes("rememberLastOpenedChatRoom"), "persists last opened in memory");
assert(chat.includes("readLastOpenedChatRoom"), "restores last opened on mount");
assert(chat.includes("shouldAwaitParkRuntimeCheck"), "park uses cached runtime when known on");
assert(chat.includes("enableChatEntryTimingFromSearch"), "opt-in timing from query");
assert(chat.includes("await refreshWsReuseRuntime()"), "unknown runtime still awaits kill switch");
assert(!chat.includes("chatRoomLineCache"), "does not import PR 354 cache paint");
assert(!chat.includes("shouldPaintOnAuthorizedFrame"), "does not depend on PR 355");
const chrome = readFileSync("src/components/manage/AppChrome.tsx", "utf8");
assert(chrome.includes("warmChatPhotoMediaConnection"), "shell warms Worker before /chat");
assert(chrome.includes("prefetchChatTokenIfNeeded"), "shell idle-prefetches token");
assert(chrome.includes("shouldPrefetchChatToken"), "token prefetch skips /chat");
const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
assert(!worker.includes("function sendAuthorized"), "no Worker protocol change");
const manage = readFileSync("src/components/manage/ManageShell.tsx", "utf8");
assert(/ADMIN_PREFETCH[\s\S]*"\/chat"/.test(manage), "admin idle-prefetches /chat");

void testPrefetch().then(() => {
  if (fail > 0) {
    console.error(`\nchat-entry-speed tests failed: ${fail} (passed ${pass})`);
    process.exit(1);
  }
  console.log(`\nchat-entry-speed tests passed: ${pass}`);
});
