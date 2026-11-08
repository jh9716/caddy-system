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
  retainCachedChatRooms,
  sanitizeChatRoomLinesForCache,
  shouldPaintCachedChatRoomLines,
  shouldShowChatHistoryWait,
} from "../src/lib/chatRoomLineCache";
import { applyChatSessionResetReason, clearChatSessionEnded } from "../src/lib/chatSessionReset";
import { chatWsFailureCode, isChatRoomAccessDenied } from "../src/lib/chatDmClient";
import { ROOM_FORBIDDEN_CLOSE, TOKEN_EXPIRED_CLOSE } from "../src/lib/chatReconnect";

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

section("membership paint gate / retain");
resetChatRoomLineCacheForTests();
clearChatSessionEnded();
rememberChatRoomLines(1, "custom_a", { lines: [line(1)] });
rememberChatRoomLines(1, "custom_b", { lines: [line(2)] });
rememberChatRoomLines(2, "custom_a", { lines: [line(9)] });
assert(shouldPaintCachedChatRoomLines({ serverSocketAuthorized: true }) === true, "101/DO auth may paint");
assert(shouldPaintCachedChatRoomLines({ serverSocketAuthorized: false }) === false, "no socket auth must not paint");
assert(retainCachedChatRooms(1, ["custom_b"]) === 1, "directory snapshot drops removed room");
assert(readCachedChatRoomLines(1, "custom_a") === null, "removed room cache is gone");
assert(readCachedChatRoomLines(1, "custom_b")?.lines[0]?.seq === 2, "kept room still cached");
assert(readCachedChatRoomLines(2, "custom_a")?.lines[0]?.seq === 9, "other user cache untouched");
applyChatSessionResetReason("logout");
assert(shouldPaintCachedChatRoomLines({ serverSocketAuthorized: true }) === false, "ended session cannot paint");
clearChatSessionEnded();

section("close codes");
assert(ROOM_FORBIDDEN_CLOSE === 4003, "worker membership close is 4003");
assert(chatWsFailureCode({ closeCode: 4003 }) === "room_forbidden", "4003 maps without HTTP diagnose");
assert(chatWsFailureCode({ closeCode: TOKEN_EXPIRED_CLOSE }) === "stale_session", "4008 stays stale_session");
assert(isChatRoomAccessDenied("room_forbidden") === true, "room_forbidden is deny");
assert(isChatRoomAccessDenied("ws_4003") === true, "legacy ws_4003 is still deny");
assert(isChatRoomAccessDenied("ws_timeout") === false, "timeout is not membership deny");

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

section("protocol has no pre-history auth frame");
const worker = read("cloudflare/verthill-chat/src/index.ts");
const proto = read("cloudflare/verthill-chat/src/protocol.ts");
assert(worker.includes("this.sendHistory(server, authorized.claims.userId"), "new WS sends history after 101 auth");
assert(worker.includes("this.sendHistory(ws, still.claims.userId, null, HISTORY_LIMIT)"), "resume sends history after membership");
assert(!/type:\s*"authorized"/.test(worker), "worker has no authorized frame");
assert(!/type:\s*"authorized"/.test(proto), "protocol has no authorized event");

section("ChatClient wiring");
const chat = read("src/app/chat/ChatClient.tsx");
const openStart = chat.indexOf("async function openRoom");
const openEnd = chat.indexOf("async function saveNotifyMode", openStart);
const openRoom = openStart >= 0 && openEnd > openStart ? chat.slice(openStart, openEnd) : "";
assert(chat.includes("readCachedChatRoomLines"), "cache reader exists");
assert(chat.includes("paintCachedLinesAfterServerAuth(roomId)"), "new WS open paints after 101");
{
  const resumeStart = chat.indexOf("socketResumeRef.current.set");
  const resumeEnd = chat.indexOf("const ws = new WebSocket");
  const resumeFn = resumeStart >= 0 && resumeEnd > resumeStart ? chat.slice(resumeStart, resumeEnd) : "";
  assert(!resumeFn.includes("paintCachedLinesAfterServerAuth"), "parked resume does not paint before history");
}
assert(!openRoom.includes("readCachedChatRoomLines"), "openRoom does not paint before socket");
assert(openRoom.includes("clearLocalLines([])"), "openRoom stays empty until auth");
assert(chat.includes("firstPaintAt"), "first-visit paint timing is not ws-open");
assert(chat.includes("waitForOpen: true"), "openRoom still waits for socket authorize");
assert(chat.includes("rememberActiveRoomLines()"), "leave/history remember lines");
assert(chat.includes("clearChatRoomLineCache()"), "logout wipes cache");
assert(chat.includes("dropCachedChatRoom"), "forbidden drops that room");
assert(chat.includes("serverSocketAuthorized: true"), "paint requires socket 101 auth");
assert(!chat.includes("memberRoomIds"), "list cache is not used as membership auth");
assert(chat.includes("retainCachedChatRooms"), "directory snapshot retains membership");
assert(chat.includes("isChatRoomAccessDenied"), "open fail treats deny codes");
assert(chat.includes('resolved.status === "forbidden"'), "targeted 403 drops that room");
assert(chat.includes("ROOM_FORBIDDEN_CLOSE"), "4003 drops cache");
assert(chat.includes("ev.reason === \"room_forbidden\""), "parked/live forbidden reason drops cache");
assert(chat.includes("ev.reason === \"stale_session\""), "stale parked/live socket wipes cache");
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
