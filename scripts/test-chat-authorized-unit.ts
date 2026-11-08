import { readFileSync } from "node:fs";
import {
  measureAuthorizedHistoryGap,
  parseAuthorized,
  shouldPaintOnAuthorizedFrame,
} from "../src/lib/chatAuthorized";
import { applyChatSessionResetReason, clearChatSessionEnded } from "../src/lib/chatSessionReset";
import {
  CHAT_ENTRY_TIMING_STEPS,
  recordChatEntryTiming,
  resetChatEntryTimingForTests,
  scheduleChatCacheShown,
  readChatEntryTimings,
} from "../src/lib/chatEntryTiming";
import { parkedResumeClientGate } from "../src/lib/chatWsReuse";

let pass = 0;
let fail = 0;
function assert(cond: unknown, msg: string) {
  if (cond) pass++;
  else {
    fail++;
    console.log("FAIL", msg);
  }
}

console.log("== parse / paint gate ==");
clearChatSessionEnded();
assert(parseAuthorized({ type: "authorized" })?.type === "authorized", "authorized ok");
assert(parseAuthorized({ type: "authorized", extra: 1 })?.type === "authorized", "extra keys ignored");
assert(parseAuthorized({ type: "history" }) === null, "history is not authorized");
assert(parseAuthorized({ type: "error", code: "room_forbidden" }) === null, "error is not authorized");
assert(parseAuthorized(null) === null, "null rejected");
assert(shouldPaintOnAuthorizedFrame({ type: "authorized" }) === true, "live session may paint");
assert(shouldPaintOnAuthorizedFrame({ type: "history" }) === false, "history frame does not paint cache");
applyChatSessionResetReason("logout");
assert(shouldPaintOnAuthorizedFrame({ type: "authorized" }) === false, "ended session cannot paint");
clearChatSessionEnded();

console.log("== gap / React batch ==");
assert(measureAuthorizedHistoryGap({ authorizedAt: 0, historyAt: 1 }).wouldPaintSeparately === false, "1ms batches");
assert(measureAuthorizedHistoryGap({ authorizedAt: 0, historyAt: 8 }).wouldPaintSeparately === true, "8ms may paint");
assert(
  measureAuthorizedHistoryGap({ resumeSentAt: 0, authorizedAt: 180, historyAt: 181 }).resumeToAuthorizedMs === 180,
  "session-check dominates resume"
);
assert(
  measureAuthorizedHistoryGap({ authorizedAt: 180, historyAt: 181 }).authorizedToHistoryMs === 1,
  "history follows immediately"
);

console.log("== cache shown timing ==");
resetChatEntryTimingForTests(true);
const rafs: Array<() => void> = [];
scheduleChatCacheShown(1000, {
  now: () => 1016,
  raf: (cb) => {
    rafs.push(cb);
    return 1;
  },
});
assert(readChatEntryTimings().length === 0, "shown waits for double rAF");
rafs.shift()!();
assert(readChatEntryTimings().length === 0, "first rAF not enough");
rafs.shift()!();
assert(
  readChatEntryTimings().some((m) => m.name === "room_select_to_cache_shown" && m.ms === 16),
  "double rAF records shown"
);
assert(CHAT_ENTRY_TIMING_STEPS.includes("room_select_to_authorized"), "authorized step listed");
resetChatEntryTimingForTests(true);
recordChatEntryTiming("room_select_to_authorized", 0, 180);
recordChatEntryTiming("room_select_to_history", 0, 181);
assert(readChatEntryTimings().every((m) => Object.keys(m).sort().join() === "ms,name"), "timing has no PII");

console.log("== compatibility / source ==");
assert(parkedResumeClientGate("authorized") === "other", "missing history still waits");
assert(parkedResumeClientGate("history") === "history", "old worker history still completes resume");
const chat = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
assert(chat.includes("shouldPaintOnAuthorizedFrame"), "client keys off authorized");
assert(!/ws\.addEventListener\("open"[\s\S]{0,900}paintCachedLinesAfterServerAuth/.test(chat), "open does not paint");
assert(chat.includes("room_select_to_authorized"), "click to authorized recorded");
assert(chat.includes("room_select_to_history"), "click to history recorded");
assert(!/console\.(log|debug|info)\([^)]*authorized/.test(chat), "no authorized PII logs");
const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
assert(!/console\.(log|debug|info)\([^)]*authorized/.test(worker), "worker does not log authorized");
assert(chat.includes("clearChatRoomLineCache()"), "logout still wipes");
assert(chat.includes("dropCachedChatRoom"), "deny still drops room");

if (fail > 0) {
  console.error(`\nchat-authorized tests failed: ${fail} (passed ${pass})`);
  process.exit(1);
}
console.log(`\nchat-authorized tests passed: ${pass}`);
