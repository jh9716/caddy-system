import { readFileSync } from "node:fs";
import {
  clearChatFastEntryCache, invalidateChatToken, isReusableChatToken, openPushPathInApp, placeholderChatRoomSummary, PLACEHOLDER_ROOM_TITLE,
  readCachedChatRooms, readReusableChatToken, rememberChatRooms, rememberChatToken, safeInAppPath, CHAT_OPEN_ROOM_EVENT,
} from "../src/lib/chatFastEntry";
import { applyChatSessionResetReason, clearChatSessionEnded } from "../src/lib/chatSessionReset";
let pass = 0, fail = 0;
const ok = (c: unknown, m: string) => { if (c) pass++; else { fail++; console.log("FAIL", m); } };
const now = 1_000_000;
ok(isReusableChatToken({ token: "t", exp: now + 1800 }, now), "fresh reusable");
ok(!isReusableChatToken({ token: "t", exp: now + 100 }, now), "inside 120s margin not reusable");
ok(!isReusableChatToken({ token: "", exp: now + 1800 }, now), "empty token");
ok(!isReusableChatToken(null, now), "null");
const tok = (uid: number, exp = Math.floor(Date.now() / 1000) + 1800) => ({ token: "x", exp, user: { userId: uid } });
clearChatFastEntryCache();
ok(readReusableChatToken() === null, "empty cache");
rememberChatToken(tok(1)); ok(readReusableChatToken()?.user.userId === 1, "cached");
rememberChatRooms(1, [{ roomId: "all" }]); ok(readCachedChatRooms(1)?.length === 1, "rooms cached");
ok(readCachedChatRooms(2) === null, "other user no rooms");
rememberChatToken(tok(2)); ok(readCachedChatRooms(1) === null, "user change drops rooms");
invalidateChatToken(); ok(readReusableChatToken() === null, "invalidate");
rememberChatToken(tok(3, Math.floor(Date.now() / 1000) + 60)); ok(readReusableChatToken() === null, "near-expiry dropped");
rememberChatToken(tok(4)); applyChatSessionResetReason("logout");
ok(readReusableChatToken() === null, "session ended → no reuse");
rememberChatToken(tok(5)); ok(readReusableChatToken() === null, "ended → not stored");
clearChatSessionEnded(); clearChatFastEntryCache();
const ph = placeholderChatRoomSummary("room_aaaaaaaaaaaaaaaa"); ok(ph.type === "CUSTOM" && ph.unread === 0, "placeholder custom");
ok(placeholderChatRoomSummary("all").type === "ALL", "placeholder all"); ok(placeholderChatRoomSummary("dm_1_2").type === "DM", "placeholder dm");
const O = "https://www.verthill.kr";
ok(safeInAppPath("/chat?room=all", O) === "/chat?room=all", "relative ok");
ok(safeInAppPath(O + "/chat", O) === "/chat", "same origin abs ok");
ok(safeInAppPath("https://evil.example/chat", O) === null, "cross origin blocked");
ok(safeInAppPath("//evil.example/x", O) === null, "protocol-relative blocked");
ok(safeInAppPath("javascript:alert(1)", O) === null, "js blocked");
ok(safeInAppPath("", O) === null, "empty");
// openPushPathInApp with fake window
const mk = (pathname: string) => { const ev: string[] = []; const hist: string[] = []; return { ev, hist, w: { location: { origin: O, pathname }, history: { state: null, pushState: (_s: unknown, _t: string, u: string) => hist.push(u) }, dispatchEvent: (e: Event) => { ev.push((e as CustomEvent).type + ":" + (e as CustomEvent).detail?.roomId); return true; } } as unknown as Window }; };
{ const f = mk("/chat"); const pushed: string[] = []; ok(openPushPathInApp("/chat?room=all", (p) => pushed.push(p), f.w) && f.ev[0] === `${CHAT_OPEN_ROOM_EVENT}:all` && pushed.length === 0 && f.hist[0] === "/chat?room=all", "on /chat → in-place open event"); }
{ const f = mk("/caddy"); const pushed: string[] = []; ok(openPushPathInApp("/chat?room=all", (p) => pushed.push(p), f.w) && pushed[0] === "/chat?room=all" && f.ev.length === 0, "elsewhere → router push"); }
{ const f = mk("/caddy"); const pushed: string[] = []; ok(!openPushPathInApp("https://evil.example/", (p) => pushed.push(p), f.w) && pushed.length === 0, "cross origin refused"); }
{ ok(!openPushPathInApp("/chat", () => { throw new Error("x"); }, mk("/caddy").w), "router error → false (fallback)"); }
// source guards
const src = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
ok(/readReusableChatToken<TokenPayload>\(\)/.test(src) && /cachedToken \?\? \(await fetchToken\(\)\)/.test(src), "token reuse in init");
ok(/readPersistedChatListForPaint/.test(src), "persisted list paint on restart");
ok(/const staleCached = !dirOpened && usedCachedTokenRef\.current/.test(src), "stale cached token refresh");
ok(/startEarlyDeepLink\(requested\)/.test(src) && /closeEarlyDeepLinkDenied\(\)/.test(src), "early deep link + deny path");
ok(/fetchTargetedRoom\(info\.token, requested\);\s*\/\/[^\n]*\n[^\n]*\n\s*startEarlyDeepLink/.test(src), "targeted permission fetch kept with early open");
ok(!/localStorage\.setItem\([^)]*token/i.test(src) && !/sessionStorage\.setItem\([^)]*token/i.test(src), "no token persistence");
const sw = readFileSync("public/sw.js", "utf8");
ok(/tryInAppRoute\(client, url\)\) return;\s*if \(typeof client\.navigate !== "function"\) continue;/.test(sw), "sw falls back to navigate");
ok(/setTimeout\(\(\) => finish\(false\), 700\)/.test(sw), "sw ack timeout 700ms");
ok(placeholderChatRoomSummary("room_aaaaaaaaaaaaaaaa").name === PLACEHOLDER_ROOM_TITLE && PLACEHOLDER_ROOM_TITLE !== "채팅방", "placeholder title is loading, not fake name");
ok(/openRoom\(room, \{ targetSeq, holdForSummary: true \}\)/.test(src), "early deep link holds entry");
ok(/releaseEntryHold\(real && real\.roomId === requested \? real : null\)/.test(src), "real summary releases hold");
ok(!/ws\.send\(JSON\.stringify\(\{ type: "read", seq: (last|line)\.seq \}\)\)/.test(src), "all read sends go through hold gate");
ok(/if \(!historyResetRef\.current\) queueEntrySeek/.test(src), "release before history defers seek");
console.log(`${pass} passed, ${fail} failed`); if (fail) process.exit(1);
