import { readFileSync } from "node:fs";
import {
  CHAT_ENTRY_TIMING_STEPS,
  chatTokenServerTiming,
  classifyChatInitFailure,
  isChatEntryTimingEnabledFor,
  mergeLateNotifyPrefs,
  readChatEntryTimings,
  recordChatEntryTiming,
  resetChatEntryTimingForTests,
} from "../src/lib/chatEntryTiming";

let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };

// enable gating
ok(isChatEntryTimingEnabledFor("preview", "production"), "preview on");
ok(isChatEntryTimingEnabledFor("production", "development"), "local dev on");
ok(!isChatEntryTimingEnabledFor("production", "production"), "production off");
ok(!isChatEntryTimingEnabledFor("production", undefined), "unknown off");

// disabled → nothing recorded
resetChatEntryTimingForTests(false);
ok(recordChatEntryTiming("token", 0, 50) === null, "disabled returns null");
ok(readChatEntryTimings().length === 0, "disabled no marks");

resetChatEntryTimingForTests(true);
ok(recordChatEntryTiming("token", 10, 60.4) === 50, "ms rounded");
ok(recordChatEntryTiming("token", null, 60) === null, "null start skipped");
ok(recordChatEntryTiming("token", NaN, 60) === null, "NaN skipped");
ok(recordChatEntryTiming("bogus" as never, 0, 1) === null, "unknown step rejected");
ok(recordChatEntryTiming("rooms_to_shown", 100, 50) === 0, "negative clamped");
const marks = readChatEntryTimings();
ok(marks.length === 2, "two marks");
ok(marks.every((m) => Object.keys(m).sort().join() === "ms,name"), "only name+ms keys");
for (let i = 0; i < 300; i++) recordChatEntryTiming("token", 0, 1);
ok(readChatEntryTimings().length === 200, "bounded");
ok(CHAT_ENTRY_TIMING_STEPS.length === 8, "8 steps");
ok(CHAT_ENTRY_TIMING_STEPS.includes("room_select_to_first_paint"), "first paint step");
ok(CHAT_ENTRY_TIMING_STEPS.every((s) => !/id|room=|token=|user/i.test(s.replace(/^token$/, "")) ), "step names carry no identifiers");

// late prefs merge
const dirty = new Set(["a"]);
const merged = mergeLateNotifyPrefs({ a: "OFF" }, { a: "ALL", b: "MENTION" }, dirty);
ok(merged.a === "OFF" && merged.b === "MENTION", "dirty kept, others applied");
ok(mergeLateNotifyPrefs({}, { a: "OFF" }, new Set()).a === "OFF", "clean applied");
ok(mergeLateNotifyPrefs({ c: "OFF" }, {}, new Set()).c === "OFF", "local-only kept");
ok(!("x" in mergeLateNotifyPrefs({}, { x: "OFF" }, new Set(["x"]))), "dirty-without-current drops server value (default)");

ok(classifyChatInitFailure({ status: 401 }) === "auth", "401 auth");
ok(classifyChatInitFailure({ status: 403 }) === "auth", "403 auth");
ok(classifyChatInitFailure({ status: 500 }) === "network", "500 net");
ok(classifyChatInitFailure({ thrown: true }) === "network", "throw net");

ok(chatTokenServerTiming(12.6, 3.2) === "auth;dur=13, issue;dur=3", "server-timing format");
ok(chatTokenServerTiming(NaN, -5) === "auth;dur=0, issue;dur=0", "server-timing sanitized");

// source checks: prefs no longer awaited before loading end; no identifiers passed to timing
const src = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
const init = src.slice(src.indexOf("const info = cachedToken ?? (await fetchToken());"), src.indexOf("}, [connectDirectory, connectSocket, fetchRoomsHttp"));
ok(/void \(async \(\) => \{\s*try \{\s*const prefRes = await fetch\("\/api\/chat\/notification-prefs"/.test(init), "prefs fetched non-blocking");
ok(init.indexOf("notification-prefs") < init.indexOf("await fetchRoomsHttp"), "prefs started before rooms await");
ok(/mergeLateNotifyPrefs\(cur, incoming, notifyDirtyRef\.current\)/.test(init), "late prefs merge used");
ok(/notifyDirtyRef\.current\.add\(room\.roomId\)/.test(src), "save marks dirty");
ok(/setInitFailed\(true\)/.test(init), "network error → retry state");
const calls = src.match(/recordChatEntryTiming\([^)]*\)/g) || [];
ok(calls.length >= 7, "timing calls present");
ok(calls.every((c) => !/roomId|userId|token\b|\.search|location|message/i.test(c.replace('"token"', ""))), "no identifiers in timing calls");
ok(/if \(!roomsShownRef\.current\) \{[\s\S]{0,200}setLoading\(false\)/.test(src), "first valid rooms (WS or HTTP) ends loading");
ok(src.includes("firstPaintAt"), "first paint start is kept after ws open");
ok(src.includes("room_select_to_first_paint"), "first paint step is recorded");
const route = readFileSync("src/app/api/chat/token/route.ts", "utf8");
ok(/isChatEntryTimingEnabledFor\(currentChatAppEnv\(\), process\.env\.NODE_ENV\)/.test(route), "server-timing gated");

console.log(`${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
