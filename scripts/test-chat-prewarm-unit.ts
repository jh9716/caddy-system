import { readFileSync } from "node:fs";
import {
  CHAT_PREWARM_MAX_ROOMS,
  canAdoptChatPrewarm,
  chatPrewarmReadyFromFrame,
  pickChatPrewarmRoom,
  shouldDropPrewarmOnDirectory,
  shouldHoldChatReadWhilePrewarm,
  shouldStartChatPrewarm,
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
  "stale list cache cannot pick"
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
  "unready must use cold entry"
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
  shouldHoldChatReadWhilePrewarm({ prewarming: true, viewIsRoom: false }) === true,
  "list prewarm does not send read"
);
assert(
  shouldHoldChatReadWhilePrewarm({ prewarming: true, viewIsRoom: true }) === false,
  "opened room may send read"
);
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
assert(chat.includes("canAdoptChatPrewarm"), "click adopts only when ready");
assert(chat.includes("shouldHoldChatReadWhilePrewarm"), "read held on list");
assert(chat.includes("dropChatPrewarm"), "deny/session drops prewarm");
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
