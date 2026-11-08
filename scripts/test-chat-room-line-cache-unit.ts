/**
 * In-tab room line cache for instant re-open paint.
 * 실행: npm run test:chat-room-line-cache-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  CHAT_ROOM_LINE_CACHE_MAX_LINES,
  CHAT_ROOM_LINE_CACHE_MAX_ROOMS,
  CHAT_ROOM_LINE_CACHE_TTL_MS,
  chatRoomLineCacheSizeForTests,
  clearChatRoomLineCache,
  dropCachedChatRoom,
  getChatRoomPaintTiming,
  markChatRoomCachePainted,
  markChatRoomHistoryPainted,
  markChatRoomOpenStarted,
  readCachedChatRoomLines,
  rememberChatRoomLines,
  resetChatRoomLineCacheForTests,
  sanitizeChatRoomLinesForCache,
  shouldShowChatHistoryWait,
} from "../src/lib/chatRoomLineCache";
import { applyChatSessionResetReason, clearChatSessionEnded } from "../src/lib/chatSessionReset";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function line(seq: number, extra: Record<string, unknown> = {}) {
  return {
    clientMessageId: `c-${seq}`,
    senderUserId: 7,
    sender: "김캐디",
    senderRole: "caddy",
    body: `hello ${seq}`,
    sentAt: "2026-11-08T00:00:00.000Z",
    seq,
    mentions: [],
    mentionAll: false,
    status: "sent",
    ...extra,
  };
}

function section(title: string) {
  console.log("\n==", title, "==");
}

resetChatRoomLineCacheForTests();
clearChatSessionEnded();

section("sanitize");
assert(sanitizeChatRoomLinesForCache(null).length === 0, "null → empty");
assert(sanitizeChatRoomLinesForCache([line(1, { status: "sending" })]).length === 0, "drops sending");
assert(sanitizeChatRoomLinesForCache([line(1, { status: "failed" })]).length === 0, "drops failed");
assert(
  sanitizeChatRoomLinesForCache([
    line(1, { pendingClaims: [{ id: "a", mimeType: "image/jpeg", size: 1, exp: 9, claim: "sekrit" }] }),
  ]).length === 1,
  "keeps sent line after stripping claims field"
);
assert(
  !JSON.stringify(sanitizeChatRoomLinesForCache([line(1, { pendingClaims: [{ claim: "sekrit" }] })])).includes("sekrit"),
  "claim token not copied"
);
assert(
  sanitizeChatRoomLinesForCache([
    line(1, { attachments: [{ id: "att-1", mimeType: "image/jpeg", size: 12, claim: "tok", exp: 9 }] }),
  ])[0]?.attachments == null,
  "drops attachments that carry claim/exp"
);
assert(
  sanitizeChatRoomLinesForCache([
    line(1, { attachments: [{ id: "att-1", mimeType: "image/jpeg", size: 12 }] }),
  ])[0]?.attachments?.[0]?.id === "att-1",
  "keeps id-only attachments"
);
const many = Array.from({ length: CHAT_ROOM_LINE_CACHE_MAX_LINES + 10 }, (_, i) => line(i + 1));
assert(sanitizeChatRoomLinesForCache(many).length === CHAT_ROOM_LINE_CACHE_MAX_LINES, "caps line count");
assert(sanitizeChatRoomLinesForCache(many)[0]?.seq === 11, "keeps the newest page");

section("first visit vs remember/read");
resetChatRoomLineCacheForTests();
clearChatSessionEnded();
assert(readCachedChatRoomLines(1, "all") === null, "first visit is a miss");
assert(rememberChatRoomLines(1, "all", { lines: [line(3), line(4)], hasMore: true, oldestSeq: 3 }), "stores");
const page = readCachedChatRoomLines(1, "all");
assert(page?.lines.length === 2 && page.lines[1]?.seq === 4, "same user/room hits");
assert(page?.hasMore === true && page.oldestSeq === 3, "hasMore/oldest restored");
assert(readCachedChatRoomLines(2, "all") === null, "other user cannot read");
assert(readCachedChatRoomLines(1, "room_other") === null, "other room miss");

section("ttl / capacity");
resetChatRoomLineCacheForTests();
rememberChatRoomLines(1, "all", { lines: [line(1)] });
const stale = readCachedChatRoomLines(1, "all", Date.now() + CHAT_ROOM_LINE_CACHE_TTL_MS + 1);
assert(stale === null, "ttl expiry is a miss");
for (let i = 0; i < CHAT_ROOM_LINE_CACHE_MAX_ROOMS + 2; i++) {
  rememberChatRoomLines(1, `room_${i}`, { lines: [line(i + 1)] });
}
assert(chatRoomLineCacheSizeForTests() === CHAT_ROOM_LINE_CACHE_MAX_ROOMS, "lru room cap");
assert(readCachedChatRoomLines(1, "room_0") === null, "oldest room evicted");
assert(readCachedChatRoomLines(1, `room_${CHAT_ROOM_LINE_CACHE_MAX_ROOMS + 1}`)?.lines[0]?.seq === CHAT_ROOM_LINE_CACHE_MAX_ROOMS + 2, "newest room kept");

section("logout / drop");
resetChatRoomLineCacheForTests();
clearChatSessionEnded();
rememberChatRoomLines(1, "all", { lines: [line(8)] });
applyChatSessionResetReason("logout");
assert(readCachedChatRoomLines(1, "all") === null, "ended session cannot read");
clearChatSessionEnded();
assert(readCachedChatRoomLines(1, "all") === null, "ended session also dropped the map");
resetChatRoomLineCacheForTests();
rememberChatRoomLines(1, "all", { lines: [line(8)] });
dropCachedChatRoom(1, "all");
assert(readCachedChatRoomLines(1, "all") === null, "membership drop removes room");
rememberChatRoomLines(1, "all", { lines: [line(9)] });
clearChatRoomLineCache();
assert(readCachedChatRoomLines(1, "all") === null, "full clear");

section("wait UX + paint timing");
assert(shouldShowChatHistoryWait({ lineCount: 0, lastMessageSeq: 12 }) === true, "empty + known seq → wait");
assert(shouldShowChatHistoryWait({ lineCount: 3, lastMessageSeq: 12 }) === false, "cached/history lines hide wait");
assert(shouldShowChatHistoryWait({ lineCount: 0, lastMessageSeq: 0 }) === false, "empty room is not a wait");
markChatRoomOpenStarted(1000);
assert(markChatRoomCachePainted(1012) === 12, "cache paint ms");
assert(markChatRoomHistoryPainted(1696) === 696, "history verify ms");
const timing = getChatRoomPaintTiming();
assert(timing.paintedFromCache === true, "first paint was cache");
assert(timing.cachePaintMs === 12 && timing.historyMs === 696, "cache paint is not history RTT");
assert(timing.cachePaintMs !== timing.historyMs, "do not report cache as server speed");

section("ChatClient wiring");
const chat = read("src/app/chat/ChatClient.tsx");
assert(chat.includes("readCachedChatRoomLines"), "openRoom reads cache");
assert(chat.includes("clearLocalLines(cachedLines)"), "openRoom paints cache instead of always emptying");
assert(
  chat.indexOf("paintCachedLines(priorUserId)") < chat.indexOf("await refreshIfNeeded()"),
  "cache paint is before token refresh"
);
assert(chat.includes("firstPaintAt"), "first-visit paint timing is not ws-open");
assert(chat.includes("waitForOpen: true"), "openRoom still waits for socket authorize");
assert(chat.includes("rememberActiveRoomLines()"), "leave/history remember lines");
assert(chat.includes("clearChatRoomLineCache()"), "logout wipes cache");
assert(chat.includes("dropCachedChatRoom"), "forbidden drops that room");
assert(chat.includes("메시지를 불러오는 중"), "first-visit wait copy");
assert(chat.includes("markChatRoomCachePainted()"), "cache paint timing");
assert(chat.includes("markChatRoomHistoryPainted()"), "history verify timing");
assert(chat.includes("room_select_to_first_paint"), "first paint timing step");
assert(!/sessionStorage\.setItem\([^)]*lines/i.test(chat), "no message persistence");
const cacheLib = read("src/lib/chatRoomLineCache.ts");
assert(!/localStorage|sessionStorage/.test(cacheLib), "cache is memory-only");
assert(!/prisma/i.test(cacheLib), "no DB");
assert(cacheLib.includes("subscribeChatSessionReset"), "session reset wipes cache");
assert(chat.includes("shouldParkChatWsReuse"), "park/resume gate unchanged");
assert(cssHasWait(), "wait style exists");

function cssHasWait() {
  return read("src/app/globals.css").includes(".vh-chat-history-wait");
}

if (failed > 0) {
  console.error(`\nchat-room-line-cache tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-room-line-cache tests passed: ${passed}`);
