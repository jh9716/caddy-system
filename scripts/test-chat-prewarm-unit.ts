import { readFileSync } from "node:fs";
import {
  CHAT_PREWARM_MAX_ROOMS,
  addChatPrewarmWaiter,
  armChatPrewarmTimeout,
  beginChatPrewarm,
  canAdoptChatPrewarm,
  chatPrewarmReadyFromFrame,
  createChatPrewarmState,
  isChatPrewarmGenerationCurrent,
  isChatPrewarmSocketAlive,
  pickChatPrewarmRoom,
  settleChatPrewarmWaiters,
  shouldDropPrewarmOnDirectory,
  shouldHoldChatReadWhilePrewarm,
  shouldMarkChatPrewarmReady,
  shouldPaintPrewarmLines,
  shouldReuseInflightPrewarmSocket,
  shouldStartChatPrewarm,
  shouldWipePrewarmAfterDrop,
} from "../src/lib/chatPrewarm";
import { PRODUCTION_CHAT_WS_REUSE_ENABLED } from "../src/lib/chatWsReuse";
import {
  readChatEntryTimings,
  resetChatEntryTimingForTests,
  schedulePrewarmShown,
} from "../src/lib/chatEntryTiming";

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

console.log("== pick ==");
assert(CHAT_PREWARM_MAX_ROOMS === 1, "max 1 room");
assert(
  pickChatPrewarmRoom({ directorySnapshotReady: false, sessionEnded: false, rooms }) === null,
  "stale list cache cannot pick rooms[0]"
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
  "unknown last-opened does not pick first from cache"
);
assert(
  pickChatPrewarmRoom({ directorySnapshotReady: true, sessionEnded: true, rooms }) === null,
  "ended session cannot pick"
);
assert(
  pickChatPrewarmRoom({ directorySnapshotReady: true, sessionEnded: false, rooms: [] }) === null,
  "empty list cannot pick"
);
assert(
  pickChatPrewarmRoom({ directorySnapshotReady: true, sessionEnded: false, rooms }) === "all",
  "first visible room when never opened"
);
assert(
  pickChatPrewarmRoom({
    directorySnapshotReady: true,
    sessionEnded: false,
    rooms,
    lastOpenedRoomId: "dm_1_2",
  }) === "dm_1_2",
  "last opened wins if still a member"
);
assert(
  pickChatPrewarmRoom({
    directorySnapshotReady: true,
    sessionEnded: false,
    rooms,
    lastOpenedRoomId: "gone",
  }) === "all",
  "removed last-opened falls back to first"
);

console.log("== ready / adopt / read hold ==");
assert(chatPrewarmReadyFromFrame("history", []) === true, "empty history still Worker-authed");
assert(chatPrewarmReadyFromFrame("history", [{ seq: 1 }]) === true, "history with lines is ready");
assert(chatPrewarmReadyFromFrame("message", [{ seq: 1 }]) === false, "live message is not ready");
assert(chatPrewarmReadyFromFrame("open", []) === false, "101/open is not ready");
assert(
  canAdoptChatPrewarm({
    prewarmRoomId: "all",
    targetRoomId: "all",
    ready: true,
    socketOpen: true,
    sessionEnded: false,
  }) === true,
  "ready open socket may adopt"
);
assert(
  canAdoptChatPrewarm({
    prewarmRoomId: "all",
    targetRoomId: "all",
    ready: false,
    socketOpen: true,
    sessionEnded: false,
  }) === false,
  "unready must use cold entry unless inflight reuse"
);
assert(
  canAdoptChatPrewarm({
    prewarmRoomId: "all",
    targetRoomId: "dm_1_2",
    ready: true,
    socketOpen: true,
    sessionEnded: false,
  }) === false,
  "other room cannot adopt"
);
assert(
  canAdoptChatPrewarm({
    prewarmRoomId: "all",
    targetRoomId: "all",
    ready: true,
    socketOpen: false,
    sessionEnded: false,
  }) === false,
  "closed socket cannot adopt"
);
assert(
  canAdoptChatPrewarm({
    prewarmRoomId: "all",
    targetRoomId: "all",
    ready: true,
    socketOpen: true,
    sessionEnded: true,
  }) === false,
  "ended session cannot adopt"
);
assert(
  shouldHoldChatReadWhilePrewarm({ prewarming: true, viewIsRoom: false, ready: false }) === true,
  "list prewarm does not send read"
);
assert(
  shouldHoldChatReadWhilePrewarm({ prewarming: true, viewIsRoom: true, ready: false }) === true,
  "clicked but history not in: still no read"
);
assert(
  shouldHoldChatReadWhilePrewarm({ prewarming: true, viewIsRoom: true, ready: true }) === false,
  "opened room after history may send read"
);
assert(shouldPaintPrewarmLines({ ready: false }) === false, "do not paint before history");
assert(shouldPaintPrewarmLines({ ready: true }) === true, "paint only after history");
assert(shouldDropPrewarmOnDirectory({ prewarmRoomId: "all", memberRoomIds: ["room_aaa"] }) === true, "membership drop");
assert(shouldDropPrewarmOnDirectory({ prewarmRoomId: "all", memberRoomIds: ["all"] }) === false, "still a member");
assert(
  shouldStartChatPrewarm({
    viewIsList: true,
    directorySnapshotReady: true,
    sessionEnded: false,
    hasTarget: true,
    currentRoomId: null,
    inflightOrReady: false,
  }) === true,
  "list + snapshot starts one prewarm"
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
assert(
  shouldStartChatPrewarm({
    viewIsList: true,
    directorySnapshotReady: true,
    sessionEnded: false,
    hasTarget: true,
    currentRoomId: "all",
    inflightOrReady: true,
  }) === false,
  "does not open a second socket"
);
assert(
  shouldStartChatPrewarm({
    viewIsList: false,
    directorySnapshotReady: true,
    sessionEnded: false,
    hasTarget: true,
    currentRoomId: null,
    inflightOrReady: false,
  }) === false,
  "in-room does not prewarm another"
);

console.log("== inflight click / history race ==");
assert(
  shouldMarkChatPrewarmReady({
    prewarmRoomId: "all",
    historyRoomId: "all",
    isHistory: true,
  }) === true,
  "history marks ready even after view is room"
);
assert(
  shouldMarkChatPrewarmReady({
    prewarmRoomId: "all",
    historyRoomId: "all",
    isHistory: false,
  }) === false,
  "non-history does not mark ready"
);
assert(
  shouldReuseInflightPrewarmSocket({
    prewarmRoomId: "all",
    targetRoomId: "all",
    inflight: true,
    ready: false,
    socketAlive: false,
    socketPending: true,
    sessionEnded: false,
  }) === true,
  "click during start reuses pending socket, no second WS"
);
assert(
  shouldReuseInflightPrewarmSocket({
    prewarmRoomId: "all",
    targetRoomId: "all",
    inflight: true,
    ready: false,
    socketAlive: true,
    socketPending: false,
    sessionEnded: false,
  }) === true,
  "click while CONNECTING/OPEN reuses that socket"
);
assert(
  shouldReuseInflightPrewarmSocket({
    prewarmRoomId: "all",
    targetRoomId: "dm_1_2",
    inflight: true,
    ready: false,
    socketAlive: true,
    socketPending: false,
    sessionEnded: false,
  }) === false,
  "other room does not reuse prewarm socket"
);
assert(isChatPrewarmSocketAlive(0) === true, "CONNECTING is alive");
assert(isChatPrewarmSocketAlive(1) === true, "OPEN is alive");
assert(isChatPrewarmSocketAlive(2) === false, "CLOSING is not reusable");
assert(isChatPrewarmSocketAlive(3) === false, "CLOSED is not reusable");

const raced = createChatPrewarmState();
const gen = beginChatPrewarm(raced, "all");
assert(isChatPrewarmGenerationCurrent(raced, gen) === true, "begin generation current");
const got: boolean[] = [];
addChatPrewarmWaiter(raced, (ok) => got.push(ok));
addChatPrewarmWaiter(raced, (ok) => got.push(ok));
const viewIsRoom = true;
assert(
  shouldMarkChatPrewarmReady({
    prewarmRoomId: raced.roomId,
    historyRoomId: "all",
    isHistory: true,
  }) === true,
  "view=room does not block mark"
);
assert(viewIsRoom === true, "click already switched view");
raced.ready = true;
raced.inflight = false;
settleChatPrewarmWaiters(raced, true, () => {});
assert(got.length === 2 && got[0] === true && got[1] === true, "connect wait + click wait both complete");
assert(raced.waiters.length === 0, "waiters drained");

const timed = createChatPrewarmState();
beginChatPrewarm(timed, "all");
let timeoutFired = false;
const scheduled: Array<() => void> = [];
armChatPrewarmTimeout(timed, 1, (cb) => {
  scheduled.push(cb);
  return 99;
}, () => {
  timeoutFired = true;
  settleChatPrewarmWaiters(timed, false, () => {});
  timed.inflight = false;
  timed.roomId = null;
});
armChatPrewarmTimeout(timed, 1, (cb) => {
  scheduled.push(cb);
  return 100;
}, () => {
  throw new Error("second timer must not arm");
});
assert(timed.timer === 99, "one shared timeout");
assert(scheduled.length === 1, "second arm is a no-op");
const timeoutGot: boolean[] = [];
addChatPrewarmWaiter(timed, (ok) => timeoutGot.push(ok));
scheduled[0]!();
assert(timeoutFired === true, "timeout runs");
assert(timeoutGot[0] === false, "timeout fails waiters");
assert(timed.timer === null, "timeout clears timer");
assert(timed.waiters.length === 0, "timeout drains waiters");

const dropped = createChatPrewarmState();
beginChatPrewarm(dropped, "all");
dropped.timer = 7;
const cleared: number[] = [];
const dropGot: boolean[] = [];
addChatPrewarmWaiter(dropped, (ok) => dropGot.push(ok));
dropped.generation += 1;
settleChatPrewarmWaiters(dropped, false, (id) => cleared.push(id));
dropped.ready = false;
dropped.inflight = false;
dropped.roomId = null;
assert(dropGot[0] === false, "session/membership drop fails waiters");
assert(cleared[0] === 7, "drop clears timer");
assert(isChatPrewarmGenerationCurrent(dropped, gen) === false, "drop supersedes in-flight connect");
assert(shouldWipePrewarmAfterDrop({ viewIsRoom: false }) === true, "list drop wipes messages and ignores socket");
assert(shouldWipePrewarmAfterDrop({ viewIsRoom: true }) === false, "active room drop does not steal the live socket");

console.log("== shown timing ==");
resetChatEntryTimingForTests(true);
const rafs: Array<() => void> = [];
schedulePrewarmShown(50, {
  now: () => 58,
  raf: (cb) => {
    rafs.push(cb);
    return 1;
  },
});
rafs.shift()!();
rafs.shift()!();
assert(
  readChatEntryTimings().some((m) => m.name === "prewarm_click_to_shown" && m.ms === 8),
  "double rAF is shown, not frame receipt"
);

console.log("== ChatClient / no 354 cache / reuse ==");
const chat = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
assert(chat.includes("startChatPrewarm"), "prewarm starter");
assert(chat.includes("waitForHistory: true"), "prewarm waits for Worker history");
assert(chat.includes("waitChatPrewarmSettled"), "shared waiter for connect + click");
assert(chat.includes("shouldMarkChatPrewarmReady"), "history marks ready independent of view");
assert(!/viewRef\.current !== "room" &&\s*prewarmRef\.current\.roomId === roomId/.test(chat), "view=room no longer blocks mark");
assert(chat.includes("shouldReuseInflightPrewarmSocket"), "same-room click reuses inflight socket");
assert(chat.includes("shouldPaintPrewarmLines"), "no paint before history");
assert(chat.includes("shouldHoldChatReadWhilePrewarm"), "read held on list");
assert(chat.includes("dropChatPrewarm"), "deny/session drops prewarm");
assert(chat.includes("shouldWipePrewarmAfterDrop"), "list drop bumps roomGen so parked events cannot send read");
assert(chat.includes("lastOpenedRoomIdRef.current = null"), "session reset forgets last opened room");
assert(chat.includes("rememberLastOpenedChatRoom"), "last opened survives /chat remount in memory");
assert(chat.includes("shouldPaintCachedRoomsNow"), "layout cache list paint");
assert(/subscribeChatSessionReset[\s\S]{0,400}clearLocalLines\(\[\]\)/.test(chat), "session reset wipes prewarmed lines");
assert(chat.includes("beginChatPrewarm"), "generation bump on start");
assert(chat.includes("prewarmGen"), "connect aborted when superseded");
assert(chat.includes('window.addEventListener("offline"'), "offline fail-closed");
assert(chat.includes("waitForOpen: true"), "cold path still waits for socket");
assert(chat.includes("shouldParkChatWsReuse"), "park/resume kept");
assert(!chat.includes("chatRoomLineCache"), "does not import PR 354 cache paint");
assert(!chat.includes("paintCachedLines"), "does not paint cache before auth");
assert(!chat.includes("shouldPaintOnAuthorizedFrame"), "does not depend on PR 355 authorized");
const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
assert(!worker.includes("function sendAuthorized"), "no Worker protocol change");
assert(PRODUCTION_CHAT_WS_REUSE_ENABLED === true, "reuse compile flag unchanged");

if (fail > 0) {
  console.error(`\nchat-prewarm tests failed: ${fail} (passed ${pass})`);
  process.exit(1);
}
console.log(`\nchat-prewarm tests passed: ${pass}`);
