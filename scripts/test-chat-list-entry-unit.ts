import { readFileSync } from "node:fs";
import {
  CHAT_ROOMS_STORAGE_KEY,
  clearPersistedChatRooms,
  parsePersistedChatRooms,
  readPersistedChatRooms,
  setChatRoomsPersistStorage,
  shouldAwaitDirectoryHttp,
  shouldDropPersistedRoomsOnToken,
  shouldPaintPersistedRooms,
  shouldReuseChatSocket,
  writePersistedChatRooms,
  WS_CONNECTING,
  WS_OPEN,
} from "../src/lib/chatListEntry";
import {
  clearChatFastEntryCache,
  prefetchChatTokenIfNeeded,
  readCachedChatRooms,
  readPersistedChatListForPaint,
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
  name: id === "all" ? "전체 채팅방" : "방",
  type: id === "all" ? ("ALL" as const) : ("CUSTOM" as const),
  ownerUserId: null,
  memberCount: 2,
  lastMessageSeq: 1,
  lastMessagePreview: "안녕",
  lastMessageAt: "2026-11-08T00:00:00.000Z",
  lastSenderName: "A",
  lastSenderRole: "caddy",
  unread: 0,
  createdAt: "2026-11-01T00:00:00.000Z",
});

clearChatSessionEnded();
clearChatFastEntryCache();
const store = memoryStorage();
setChatRoomsPersistStorage(store);

ok(shouldPaintPersistedRooms({ sessionEnded: false, roomCount: 2 }) === true, "paint when rooms exist");
ok(shouldPaintPersistedRooms({ sessionEnded: true, roomCount: 2 }) === false, "no paint after logout");
ok(shouldPaintPersistedRooms({ sessionEnded: false, roomCount: 0 }) === false, "no paint empty");
ok(shouldDropPersistedRoomsOnToken({ persistedUserId: 1, tokenUserId: 2 }) === true, "other user dropped");
ok(shouldDropPersistedRoomsOnToken({ persistedUserId: 1, tokenUserId: 1 }) === false, "same user kept");
ok(shouldDropPersistedRoomsOnToken({ persistedUserId: null, tokenUserId: 1 }) === false, "no persist");
ok(shouldReuseChatSocket(WS_OPEN) === true, "reuse OPEN");
ok(shouldReuseChatSocket(WS_CONNECTING) === true, "reuse CONNECTING");
ok(shouldReuseChatSocket(2) === false, "CLOSING not reused");
ok(shouldReuseChatSocket(3) === false, "CLOSED not reused");
ok(shouldAwaitDirectoryHttp({ paintedRoomCount: 0 }) === true, "cold awaits HTTP");
ok(shouldAwaitDirectoryHttp({ paintedRoomCount: 3 }) === false, "painted skips HTTP");

ok(parsePersistedChatRooms({ v: 1, userId: 1, rooms: [room("all")], token: "secret" }) === null, "token field rejected");
ok(parsePersistedChatRooms({ v: 1, userId: 1, rooms: [{ roomId: "all" }] }) === null, "typeless row rejected");
ok(parsePersistedChatRooms({ v: 1, userId: 1, rooms: [room("all")] })?.rooms.length === 1, "valid persist");

rememberChatRooms(1, [room("all"), room("room_aaaaaaaaaaaaaaaa")]);
ok(readCachedChatRooms(1)?.length === 2, "memory rooms");
ok(readPersistedChatRooms()?.userId === 1, "persist written");
ok(!String(store.getItem(CHAT_ROOMS_STORAGE_KEY) || "").includes("token"), "persist json has no token");

const json = store.getItem(CHAT_ROOMS_STORAGE_KEY);
clearChatFastEntryCache();
ok(readPersistedChatRooms() === null, "logout/clear wipes persist");
ok(json, "snapshot kept for hydrate");
store.setItem(CHAT_ROOMS_STORAGE_KEY, json!);
ok(readCachedChatRooms(1)?.length === 2, "hydrate persist after memory death");
ok(readCachedChatRooms(2) === null, "other user cannot read persist");
ok(readPersistedChatListForPaint()?.userId === 1, "paint helper reads persist");

applyChatSessionResetReason("logout");
ok(readPersistedChatListForPaint() === null, "ended session no paint");
clearChatFastEntryCache();
ok(store.getItem(CHAT_ROOMS_STORAGE_KEY) === null, "logout clear removes storage key");
ok(readPersistedChatRooms() === null, "persist gone after clear");
clearChatSessionEnded();

rememberChatRooms(1, [room("all")]);
rememberChatToken({ token: "x", exp: Math.floor(Date.now() / 1000) + 1800, user: { userId: 2 } });
ok(readCachedChatRooms(1) === null, "user switch drops memory rooms");
ok(readPersistedChatRooms() === null, "user switch drops persist");

writePersistedChatRooms(3, [room("all")]);
ok(readPersistedChatRooms()?.userId === 3, "direct write");
clearPersistedChatRooms();
ok(readPersistedChatRooms() === null, "direct clear");
clearChatFastEntryCache();

function finish() {
  const src = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
  ok(/readPersistedChatListForPaint/.test(src) && /useLayoutEffect/.test(src), "layout paints persist");
  ok(/warmChatPhotoMediaConnection\(\);\s*\n\s*const cachedToken/.test(src), "Worker warm overlaps token POST");
  ok(/shouldAwaitDirectoryHttp/.test(src), "HTTP skipped when list already painted");
  ok(/shouldReuseChatSocket\(dirRef/.test(src) && /shouldReuseChatSocket\(wsRef/.test(src), "visibility reuses OPEN sockets");
  ok(/clearChatFastEntryCache\(\)/.test(src), "401/403 wipe persist");
  ok(!/localStorage\.setItem\([^)]*token/i.test(src) && !/sessionStorage\.setItem\([^)]*token/i.test(src), "no token persistence");
  ok(!/skip.*session-check/i.test(src), "client does not skip session-check");

  const chrome = readFileSync("src/components/manage/AppChrome.tsx", "utf8");
  ok(/prefetchChatTokenIfNeeded/.test(chrome) && /warmChatPhotoMediaConnection/.test(chrome), "shell warms Worker and token");
  const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
  ok(/assertChatSessionCurrent/.test(worker), "Worker session-check unchanged");
  ok(/handleParkedResume/.test(worker), "Worker resume unchanged");

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
