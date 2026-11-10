import { readFileSync } from "node:fs";
import {
  CHAT_ROOMS_STORAGE_KEY,
  discardLegacyChatListPersist,
  hasLegacyChatListPersist,
  setChatRoomsPersistStorage,
  shouldApplyChatRoomList,
  shouldPaintPersistedRooms,
  shouldPaintSameSessionCachedRooms,
  shouldReuseChatSocket,
  shouldStartDirectoryHttpFallback,
  WS_CONNECTING,
  WS_OPEN,
} from "../src/lib/chatListEntry";
import {
  clearChatFastEntryCache,
  prefetchChatTokenIfNeeded,
  readCachedChatRooms,
  rememberChatRooms,
  rememberChatToken,
} from "../src/lib/chatFastEntry";
import { applyChatSessionResetReason, clearChatSessionEnded } from "../src/lib/chatSessionReset";

let pass = 0;
let fail = 0;
const ok = (c: unknown, m: string) => {
  if (c) pass++;
  else {
    fail++;
    console.log("FAIL", m);
  }
};

function memoryStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => (map.has(k) ? map.get(k)! : null),
    setItem: (k: string, v: string) => {
      map.set(k, v);
    },
    removeItem: (k: string) => {
      map.delete(k);
    },
    map,
  };
}

const room = (id: string) => ({
  roomId: id,
  name: id === "all" ? "전체 채팅방" : "비공개 방",
  type: id === "all" ? ("ALL" as const) : ("CUSTOM" as const),
  ownerUserId: null,
  memberCount: 2,
  lastMessageSeq: 1,
  lastMessagePreview: "안녕 민감 미리보기",
  lastMessageAt: "2026-11-08T00:00:00.000Z",
  lastSenderName: "홍길동",
  lastSenderRole: "caddy",
  unread: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
  peerDisplayName: "상대방",
});

clearChatSessionEnded();
clearChatFastEntryCache();
const store = memoryStorage();
setChatRoomsPersistStorage(store);

ok(shouldPaintPersistedRooms({ sessionEnded: false, roomCount: 2 }) === false, "never paint persist");
ok(
  shouldApplyChatRoomList({ source: "cache", sessionEnded: false, authenticated: true }) === false,
  "cache is not membership"
);
ok(
  shouldApplyChatRoomList({ source: "directory", sessionEnded: false, authenticated: false }) === false,
  "unauthenticated directory ignored"
);
ok(
  shouldApplyChatRoomList({ source: "directory", sessionEnded: true, authenticated: true }) === false,
  "ended session no list"
);
ok(
  shouldApplyChatRoomList({ source: "directory", sessionEnded: false, authenticated: true }) === true,
  "auth directory list applies"
);
ok(
  shouldPaintSameSessionCachedRooms({
    sessionEnded: false,
    tokenUserId: 1,
    cacheUserId: 1,
    cachedRoomCount: 2,
  }) === true,
  "same-session cache paint after token"
);
ok(
  shouldPaintSameSessionCachedRooms({
    sessionEnded: true,
    tokenUserId: 1,
    cacheUserId: 1,
    cachedRoomCount: 2,
  }) === false,
  "ended session no cache paint"
);
ok(
  shouldPaintSameSessionCachedRooms({
    sessionEnded: false,
    tokenUserId: 2,
    cacheUserId: 1,
    cachedRoomCount: 2,
  }) === false,
  "other user cache blocked"
);
ok(
  shouldPaintSameSessionCachedRooms({
    sessionEnded: false,
    tokenUserId: 1,
    cacheUserId: 1,
    cachedRoomCount: 0,
  }) === false,
  "empty cache not painted"
);
ok(
  shouldPaintSameSessionCachedRooms({
    sessionEnded: false,
    tokenUserId: null,
    cacheUserId: 1,
    cachedRoomCount: 2,
  }) === false,
  "no token no cache paint"
);
ok(shouldReuseChatSocket(WS_OPEN) === true, "reuse OPEN");
ok(shouldReuseChatSocket(WS_CONNECTING) === true, "reuse CONNECTING");
ok(shouldReuseChatSocket(2) === false, "CLOSING not reused");
ok(shouldReuseChatSocket(3) === false, "CLOSED not reused");

ok(
  shouldStartDirectoryHttpFallback({ sessionEnded: false, hasToken: true }) === true,
  "HTTP fallback with token"
);
ok(
  shouldStartDirectoryHttpFallback({
    sessionEnded: false,
    hasToken: true,
    hasCachedRooms: true,
    directoryWsSlow: true,
  }) === true,
  "WS delay still starts HTTP"
);
ok(
  shouldStartDirectoryHttpFallback({
    sessionEnded: false,
    hasToken: true,
    directoryWsFailed: true,
  }) === true,
  "WS fail still starts HTTP"
);
ok(
  shouldStartDirectoryHttpFallback({ sessionEnded: true, hasToken: true }) === false,
  "logout skips HTTP"
);
ok(
  shouldStartDirectoryHttpFallback({ sessionEnded: false, hasToken: false }) === false,
  "no token skips HTTP"
);

const leftover = JSON.stringify({
  v: 1,
  userId: 1,
  rooms: [room("all"), room("room_aaaaaaaaaaaaaaaa")],
});
store.setItem(CHAT_ROOMS_STORAGE_KEY, leftover);
ok(hasLegacyChatListPersist() === true, "legacy v1 present");
ok(leftover.includes("안녕 민감 미리보기") && leftover.includes("상대방"), "legacy held PII");
discardLegacyChatListPersist();
ok(hasLegacyChatListPersist() === false, "legacy PII wiped");
ok(store.getItem(CHAT_ROOMS_STORAGE_KEY) === null, "storage key removed");

rememberChatRooms(1, [room("all"), room("room_aaaaaaaaaaaaaaaa")]);
ok(readCachedChatRooms(1)?.length === 2, "same-tab memory rooms");
ok(store.getItem(CHAT_ROOMS_STORAGE_KEY) === null, "rememberChatRooms does not persist");
ok(readCachedChatRooms(2) === null, "other user no memory rooms");

applyChatSessionResetReason("logout");
ok(readCachedChatRooms(1) === null, "logout: no cached rooms");
ok(
  shouldApplyChatRoomList({ source: "directory", sessionEnded: true, authenticated: true }) === false,
  "logout: list apply blocked"
);
clearChatFastEntryCache();
ok(store.getItem(CHAT_ROOMS_STORAGE_KEY) === null, "logout clear keeps storage empty");
clearChatSessionEnded();

rememberChatRooms(1, [room("all")]);
rememberChatToken({ token: "x", exp: Math.floor(Date.now() / 1000) + 1800, user: { userId: 2 } });
ok(readCachedChatRooms(1) === null, "A→B drops A rooms");
ok(readCachedChatRooms(2) === null, "B has no A leftover rooms");
clearChatFastEntryCache();

store.setItem(CHAT_ROOMS_STORAGE_KEY, leftover);
rememberChatRooms(1, [room("all")]);
ok(store.getItem(CHAT_ROOMS_STORAGE_KEY) === null, "writing memory cache discards leftover persist");
clearChatFastEntryCache();

function finish() {
  const src = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
  ok(/discardLegacyChatListPersist/.test(src), "startup wipes leftover persist");
  ok(!/readPersistedChatListForPaint/.test(src), "no persist paint helper");
  ok(/shouldPaintSameSessionCachedRooms/.test(src) && /readCachedChatRooms/.test(src), "same-session cache after token");
  ok(
    /tokenRef\.current = info[\s\S]*readCachedChatRooms[\s\S]*connectDirectory\(info\)/.test(src),
    "cache paint is after token and before Directory"
  );
  const layoutStart = src.indexOf("discardLegacyChatListPersist");
  const layoutEnd = src.indexOf("useEffect(() => {", layoutStart);
  const layout = layoutStart >= 0 && layoutEnd > layoutStart ? src.slice(layoutStart, layoutEnd) : "";
  ok(layout.length > 0 && !/readCachedChatRooms/.test(layout), "layout does not paint memory cache before token");
  ok(/shouldApplyChatRoomList/.test(src), "directory-only apply gate");
  ok(/warmChatPhotoMediaConnection\(\);\s*\n\s*const cachedToken/.test(src), "Worker warm overlaps token POST");
  ok(/shouldStartDirectoryHttpFallback/.test(src) && /await fetchRoomsHttp/.test(src), "HTTP fallback always after token");
  ok(
    /shouldStartDirectoryHttpFallback\(\{[\s\S]*hasToken: Boolean\(info\.token\)/.test(src),
    "HTTP still starts when cache may have painted"
  );
  ok(/shouldReuseChatSocket\(dirRef/.test(src) && /shouldReuseChatSocket\(wsRef/.test(src), "visibility reuses OPEN sockets");
  ok(/clearChatFastEntryCache\(\)/.test(src), "401/403 wipe cache");
  ok(/입장 확인 중/.test(src), "PII-free loading copy");
  ok(!/localStorage\.setItem\([^)]*token/i.test(src) && !/sessionStorage\.setItem\([^)]*token/i.test(src), "no token persistence");
  ok(!/localStorage\.setItem\(CHAT_ROOMS_STORAGE_KEY/.test(src), "ChatClient does not persist rooms");
  ok(!/skip.*session-check/i.test(src), "client does not skip session-check");

  const chrome = readFileSync("src/components/manage/AppChrome.tsx", "utf8");
  ok(/prefetchChatTokenIfNeeded/.test(chrome) && /warmChatPhotoMediaConnection/.test(chrome), "shell warms Worker and token");
  const fast = readFileSync("src/lib/chatFastEntry.ts", "utf8");
  ok(!/writePersistedChatRooms/.test(fast) && /discardLegacyChatListPersist/.test(fast), "fast entry does not persist rooms");
  const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
  ok(/assertChatSessionCurrent/.test(worker), "Worker session-check unchanged");
  ok(/handleParkedResume/.test(worker), "Worker resume unchanged");
  const listLib = readFileSync("src/lib/chatListEntry.ts", "utf8");
  ok(!/lastMessagePreview/.test(listLib) && !/peerDisplayName/.test(listLib), "list helper stores no PII fields");

  console.log(`${pass} passed, ${fail} failed`);
  if (fail) process.exit(1);
}

void (async () => {
  let fetches = 0;
  const okFetch = async () => {
    fetches += 1;
    return {
      ok: true,
      json: async () => ({
        token: "t",
        exp: Math.floor(Date.now() / 1000) + 1800,
        user: { userId: 9 },
      }),
    } as Response;
  };
  ok((await prefetchChatTokenIfNeeded(okFetch)) === true, "prefetch stores token");
  ok((await prefetchChatTokenIfNeeded(okFetch)) === false && fetches === 1, "second prefetch skipped");
  ok(!String(store.getItem(CHAT_ROOMS_STORAGE_KEY) || "").includes("t"), "prefetch does not persist token");
  finish();
})();
