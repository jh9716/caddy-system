/**
 * Chat Phase 6 — room notify prefs, recipients, collapse, deep link, onboard, DM optimistic.
 * 실행: npm run test:chat-phase6-unit
 */
import fs from "node:fs";
import { chatNotificationTag } from "../src/lib/chatRooms";
import {
  canWriteChatNotifyPref,
  chatNotifyHeaderAriaLabel,
  chatNotifyHeaderLabel,
  DEFAULT_CHAT_NOTIFY_MODE,
  parseChatNotifyMode,
  resolveChatNotifyMode,
} from "../src/lib/chatNotificationPref";
import {
  candidateUserIdsForRoom,
  exclusiveChatWebPushRows,
  isChatPushableEvent,
  selectChatPushRecipients,
  shouldNotifyChatUser,
} from "../src/lib/chatPushRecipients";
import { dispatchChatPush, loadChatNotifyPrefs } from "../src/lib/chatPushDispatch";
import { verifyChatInternalRequest, CHAT_INTERNAL_TS_HEADER, CHAT_INTERNAL_AUTH_HEADER } from "../src/lib/chatInternalAuth";
import { shouldSilentRebindWebPush } from "../src/lib/chatPushOnboarding";
import { disablePushSubscriptionsForOtherUsers } from "../src/lib/pushSubscriptionStore";
import { buildChatPushPayload, chatPushOpenPath } from "../src/lib/chatPushMessage";
import {
  nextDirectorySnapshotReady,
  parseChatDeepLinkRoomId,
  resolveChatDeepLinkAction,
  resolveDirectoryHttpRoomsApply,
  rollbackOptimisticChatRoom,
  upsertVisibleChatRoom,
} from "../src/lib/chatPhase6";
import {
  resolveChatPushOnboard,
  shouldRequestOsPermissionOnEnable,
  writeChatPushOnboardDismissed,
  readChatPushOnboardDismissed,
} from "../src/lib/chatPushOnboarding";
import { resolveMentionAll } from "../cloudflare/verthill-chat/src/protocol";
import { isInvitableChatUser } from "../src/lib/chatUsers";

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

function section(title: string) {
  console.log("\n==", title, "==");
}

section("android onboarding");
{
  const unknown = resolveChatPushOnboard({
    authenticated: true,
    mustChangePassword: false,
    userId: 8,
    dismissed: false,
    nativePlugin: true,
    nativePermission: "prompt",
    ios: false,
    standalone: false,
    notificationPermission: "default",
  });
  assert(unknown.kind === "android" && unknown.show, "permission unknown → onboarding");
  const allowed = resolveChatPushOnboard({
    authenticated: true,
    mustChangePassword: false,
    userId: 8,
    dismissed: false,
    nativePlugin: true,
    nativePermission: "granted",
    ios: false,
    standalone: false,
    notificationPermission: "granted",
  });
  assert(allowed.kind === "android" && !allowed.show, "allowed → no prompt");
  const denied = resolveChatPushOnboard({
    authenticated: true,
    mustChangePassword: false,
    userId: 8,
    dismissed: false,
    nativePlugin: true,
    nativePermission: "denied",
    ios: false,
    standalone: false,
    notificationPermission: "denied",
  });
  assert(denied.kind === "android" && !denied.show, "denied → no spam");
  const later = resolveChatPushOnboard({
    authenticated: true,
    mustChangePassword: false,
    userId: 8,
    dismissed: true,
    nativePlugin: true,
    nativePermission: "prompt",
    ios: false,
    standalone: false,
    notificationPermission: "default",
  });
  assert(later.kind === "android" && !later.show, "later dismiss persists");
  const logout = resolveChatPushOnboard({
    authenticated: false,
    mustChangePassword: false,
    userId: 8,
    dismissed: false,
    nativePlugin: true,
    nativePermission: "prompt",
    ios: false,
    standalone: false,
    notificationPermission: "default",
  });
  assert(logout.kind === "none", "logout/account missing → no onboard");
}

section("pwa onboarding");
{
  const standalone = resolveChatPushOnboard({
    authenticated: true,
    mustChangePassword: false,
    userId: 8,
    dismissed: false,
    nativePlugin: false,
    nativePermission: null,
    ios: true,
    standalone: true,
    notificationPermission: "default",
  });
  assert(standalone.kind === "pwa" && standalone.show, "standalone detection");
  assert(shouldRequestOsPermissionOnEnable("pwa"), "user gesture permission");
  const safari = resolveChatPushOnboard({
    authenticated: true,
    mustChangePassword: false,
    userId: 8,
    dismissed: false,
    nativePlugin: false,
    nativePermission: null,
    ios: true,
    standalone: false,
    notificationPermission: "default",
  });
  assert(safari.kind === "ios-safari" && safari.show, "Safari non-standalone 안내");
  assert(!shouldRequestOsPermissionOnEnable("ios-safari"), "Safari does not request OS permission");
  const store: Record<string, string> = {};
  writeChatPushOnboardDismissed(
    { setItem: (k, v) => { store[k] = v; } },
    8
  );
  assert(
    readChatPushOnboardDismissed({ getItem: (k) => store[k] ?? null }, 8),
    "subscription dismiss stored"
  );
}

section("room prefs");
{
  assert(DEFAULT_CHAT_NOTIFY_MODE === "ALL", "default ALL");
  assert(resolveChatNotifyMode(null) === "ALL", "missing row → ALL");
  assert(parseChatNotifyMode("MENTIONS") === "MENTIONS", "ALL→MENTIONS");
  assert(parseChatNotifyMode("OFF") === "OFF", "MENTIONS→OFF");
  assert(parseChatNotifyMode("bogus") == null, "invalid mode rejected");
  assert(canWriteChatNotifyPref({ roomId: "all", isMember: false }), "ALL room write");
  assert(canWriteChatNotifyPref({ roomId: "room_0123456789abcdef", isMember: true }), "custom member write");
  assert(!canWriteChatNotifyPref({ roomId: "room_0123456789abcdef", isMember: false }), "ACL 없는 room 거절");
  assert(!canWriteChatNotifyPref({ roomId: "dm_8_40", isMember: false }), "DM outsider 거절");
  assert(!canWriteChatNotifyPref({ roomId: "team-1", isMember: true }), "legacy team pref 거절");
  assert(chatNotifyHeaderLabel(undefined) === "알림", "default/ALL → 알림");
  assert(chatNotifyHeaderLabel("ALL") === "알림", "ALL → 알림");
  assert(chatNotifyHeaderLabel("MENTIONS") === "멘션만", "MENTIONS → 멘션만");
  assert(chatNotifyHeaderLabel("OFF") === "알림 끔", "OFF → 알림 끔");
  assert(chatNotifyHeaderAriaLabel("ALL").includes("모든 알림"), "aria ALL");
  assert(chatNotifyHeaderAriaLabel("MENTIONS").includes("멘션만"), "aria MENTIONS");
  assert(chatNotifyHeaderAriaLabel("OFF").includes("알림 끔"), "aria OFF");
  let prefs: Record<string, "ALL" | "MENTIONS" | "OFF"> = {};
  const roomId = "dm_8_40";
  const headerFor = () => chatNotifyHeaderLabel(prefs[roomId] ?? DEFAULT_CHAT_NOTIFY_MODE);
  assert(headerFor() === "알림", "missing pref uses default label");
  const prev = prefs[roomId] ?? DEFAULT_CHAT_NOTIFY_MODE;
  prefs = { ...prefs, [roomId]: "OFF" };
  assert(headerFor() === "알림 끔", "optimistic OFF label");
  prefs = { ...prefs, [roomId]: "MENTIONS" };
  assert(headerFor() === "멘션만", "mode change updates label");
  prefs = { ...prefs, [roomId]: prev };
  assert(headerFor() === "알림", "save failure rollback restores label");
}

section("recipient policy");
{
  const event = {
    roomId: "all",
    seq: 3,
    senderUserId: 8,
    mentionAll: false,
    mentionUserIds: [] as number[],
    replyToUserId: null as number | null,
  };
  assert(isChatPushableEvent(event), "visible message is pushable");
  assert(!isChatPushableEvent({ ...event, deletionType: "everyone" }), "deleted no push");
  assert(!shouldNotifyChatUser({ userId: 8, senderUserId: 8, mentionAll: false, mentionUserIds: [] }), "sender 제외");
  assert(shouldNotifyChatUser({ userId: 9, senderUserId: 8, mode: "ALL", mentionAll: false, mentionUserIds: [] }), "ALL includes");
  assert(!shouldNotifyChatUser({ userId: 9, senderUserId: 8, mode: "OFF", mentionAll: true, mentionUserIds: [9] }), "OFF 제외");
  assert(
    !shouldNotifyChatUser({ userId: 9, senderUserId: 8, mode: "MENTIONS", mentionAll: false, mentionUserIds: [] }),
    "MENTIONS 일반 메시지 제외"
  );
  assert(
    shouldNotifyChatUser({ userId: 9, senderUserId: 8, mode: "MENTIONS", mentionAll: false, mentionUserIds: [9] }),
    "direct mention 포함"
  );
  assert(
    shouldNotifyChatUser({ userId: 9, senderUserId: 8, mode: "MENTIONS", mentionAll: true, mentionUserIds: [] }),
    "@전체 포함"
  );
  assert(
    shouldNotifyChatUser({ userId: 9, senderUserId: 8, mode: "MENTIONS", mentionAll: false, mentionUserIds: [], replyToUserId: 9 }),
    "relevant reply 포함"
  );
  assert(
    resolveMentionAll(true, "caddy", "all") === false,
    "caddy spoof mentionAll 불가"
  );
  const dm = candidateUserIdsForRoom({
    roomId: "dm_8_40",
    memberUserIds: [8, 40],
    eligibleUserIds: [8, 9, 40, 99],
  });
  assert(dm.length === 2 && dm.includes(40) && dm.includes(8), "DM peer only");
  const custom = candidateUserIdsForRoom({
    roomId: "room_0123456789abcdef",
    memberUserIds: [8, 11],
    eligibleUserIds: [8, 9, 11, 99],
  });
  assert(custom.join(",") === "8,11", "custom membership only");
  const all = candidateUserIdsForRoom({
    roomId: "all",
    memberUserIds: [8],
    eligibleUserIds: [8, 9, 40],
  });
  assert(all.join(",") === "8,9,40", "ALL eligible users");
  const picked = selectChatPushRecipients({
    event,
    candidateUserIds: [8, 9, 40],
    prefs: { "40": "OFF" },
  });
  assert(picked.join(",") === "9", "sender+OFF filtered");
  assert(
    !isInvitableChatUser({
      id: 1,
      username: "gone",
      role: "caddy",
      caddy: { name: "퇴", team: "1조", employmentStatus: "RETIRED" },
    }),
    "RETIRED/ghost 제외"
  );
  assert(
    shouldNotifyChatUser({
      userId: 9,
      senderUserId: 8,
      mode: "MENTIONS",
      mentionAll: false,
      mentionUserIds: [],
      replyToUserId: 9,
    }),
    "reply-to-my-message"
  );
  assert(
    !shouldNotifyChatUser({
      userId: 9,
      senderUserId: 8,
      mode: "MENTIONS",
      mentionAll: false,
      mentionUserIds: [],
      replyToUserId: 7,
    }),
    "unrelated reply excluded"
  );
  const noMembers = candidateUserIdsForRoom({
    roomId: "room_0123456789abcdef",
    memberUserIds: [8, 11],
    eligibleUserIds: [8, 9, 11, 99],
  });
  assert(!noMembers.includes(9), "CUSTOM outsider 제외");
  const afterRemove = candidateUserIdsForRoom({
    roomId: "room_0123456789abcdef",
    memberUserIds: [8],
    eligibleUserIds: [8, 11],
  });
  assert(!afterRemove.includes(11), "CUSTOM removed member 제외");
}

section("prefs fail-closed");
{
  const offOk = selectChatPushRecipients({
    event: {
      roomId: "all",
      seq: 3,
      senderUserId: 8,
      mentionAll: true,
      mentionUserIds: [40],
      replyToUserId: 40,
    },
    candidateUserIds: [8, 40],
    prefs: { "40": "OFF" },
  });
  assert(offOk.length === 0, "OFF user DB 정상 → NO PUSH");
}

section("collapse + deep link");
{
  assert(chatNotificationTag("all") === "chat:all", "same room same tag");
  assert(chatNotificationTag("dm_8_40") === "chat:dm_8_40", "DM tag");
  assert(chatNotificationTag("all") !== chatNotificationTag("dm_8_40"), "different room different tag");
  const all = buildChatPushPayload({
    roomId: "all",
    roomType: "ALL",
    senderName: "홍길동",
    preview: "안녕",
    mentionAll: false,
    mentioned: false,
  });
  assert(all.url === "/chat?room=all", "ALL deep link");
  assert(all.tag === "chat:all", "ALL collapse tag");
  const custom = buildChatPushPayload({
    roomId: "room_0123456789abcdef",
    roomType: "CUSTOM",
    roomName: "운영",
    senderName: "홍길동",
    preview: "안녕",
    mentionAll: false,
    mentioned: true,
  });
  assert(custom.url === "/chat?room=room_0123456789abcdef", "CUSTOM deep link");
  assert(custom.title.includes("멘션"), "mention title");
  const dm = buildChatPushPayload({
    roomId: "dm_8_40",
    roomType: "DM",
    peerDisplayName: "이캐디",
    senderName: "이캐디",
    preview: "안녕",
    mentionAll: false,
    mentioned: false,
  });
  assert(dm.url === "/chat?room=dm_8_40", "DM deep link");
  assert(chatPushOpenPath("all") === "/chat?room=all", "open path");
  assert(parseChatDeepLinkRoomId("dm_8_40") === "dm_8_40", "parse dm");
  assert(parseChatDeepLinkRoomId("https://evil") == null, "deep link rejects absolute");
  const earlyRooms = [{ roomId: "all" }, { roomId: "room_0123456789abcdef" }];
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: earlyRooms,
      directorySnapshotReady: false,
    }) === "wait",
    "DM deep link waits until snapshot"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: [...earlyRooms, { roomId: "dm_8_40" }],
      directorySnapshotReady: true,
    }) === "open",
    "DM deep link opens after snapshot"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: earlyRooms,
      directorySnapshotReady: true,
    }) === "fallback",
    "DM missing after snapshot → fallback"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "all",
      rooms: earlyRooms,
      directorySnapshotReady: false,
    }) === "open",
    "ALL deep link still opens when already listed"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "room_0123456789abcdef",
      rooms: earlyRooms,
      directorySnapshotReady: false,
    }) === "open",
    "CUSTOM deep link still opens when already listed"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "room_0123456789abcdef",
      rooms: [],
      directorySnapshotReady: true,
    }) === "fallback",
    "forbidden fallback"
  );
  assert(nextDirectorySnapshotReady(true, "connect_start") === false, "reconnect start invalidates ready");
  assert(nextDirectorySnapshotReady(true, "connect_skip") === true, "no URL keeps previous ready");
  assert(nextDirectorySnapshotReady(false, "connect_skip") === false, "no URL keeps previous not-ready");
  assert(nextDirectorySnapshotReady(false, "socket_open") === false, "socket open is not snapshot ready");
  const afterReconnect = nextDirectorySnapshotReady(true, "connect_start");
  assert(afterReconnect === false, "stale true → false before new snapshot");
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: earlyRooms,
      directorySnapshotReady: afterReconnect,
    }) === "wait",
    "reconnect before snapshot waits"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "all",
      rooms: earlyRooms,
      directorySnapshotReady: afterReconnect,
    }) === "open",
    "listed room still opens during reconnect wait"
  );
  const afterNewSnapshot = nextDirectorySnapshotReady(afterReconnect, "authoritative_rooms");
  assert(afterNewSnapshot === true, "new authoritative rooms → ready");
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: [...earlyRooms, { roomId: "dm_8_40" }],
      directorySnapshotReady: afterNewSnapshot,
    }) === "open",
    "DM in new snapshot opens"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: earlyRooms,
      directorySnapshotReady: afterNewSnapshot,
    }) === "fallback",
    "DM missing after new snapshot → fallback"
  );
  const staleHttp = resolveDirectoryHttpRoomsApply({
    startedGen: 1,
    currentGen: 2,
    ok: true,
    rooms: [{ roomId: "all" }],
  });
  assert(staleHttp === "ignore", "stale HTTP after reconnect is ignored");
  assert(
    nextDirectorySnapshotReady(false, "connect_start") === false,
    "reconnect ready stays false when stale HTTP ignored"
  );
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "dm_8_40",
      rooms: earlyRooms,
      directorySnapshotReady: false,
    }) === "wait",
    "stale HTTP does not fallback DM"
  );
  const nextGenHttp = resolveDirectoryHttpRoomsApply({
    startedGen: 2,
    currentGen: 2,
    ok: true,
    rooms: [...earlyRooms, { roomId: "dm_8_40" }],
  });
  assert(nextGenHttp === "apply", "current-gen HTTP rooms apply");
  const afterCurrentHttp = nextDirectorySnapshotReady(false, "authoritative_rooms");
  assert(afterCurrentHttp === true, "current-gen HTTP/WS rooms → ready");
  assert(
    resolveDirectoryHttpRoomsApply({
      startedGen: 2,
      currentGen: 2,
      ok: false,
      rooms: [{ roomId: "all" }],
    }) === "ignore",
    "failed HTTP does not apply"
  );
  assert(
    resolveDirectoryHttpRoomsApply({
      startedGen: 2,
      currentGen: 2,
      ok: true,
      rooms: { not: "array" },
    }) === "ignore",
    "non-array HTTP body does not apply"
  );
}

section("DM optimistic list");
{
  const room = {
    roomId: "dm_8_40",
    type: "DM",
    lastMessageAt: "2026-10-04T00:00:00.000Z",
    lastMessageSeq: 0,
    unread: 0,
    createdAt: "2026-10-04T00:00:00.000Z",
  };
  const upserted = upsertVisibleChatRoom([], room);
  assert(upserted.length === 1 && upserted[0]?.roomId === "dm_8_40", "success immediate upsert");
  const again = upsertVisibleChatRoom(upserted, { ...room, unread: 0 });
  assert(again.length === 1, "duplicate prevention");
  const rolled = rollbackOptimisticChatRoom(again, "dm_8_40");
  assert(rolled.length === 0, "failure rollback");
}

section("source wiring");
{
  const worker = fs.readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
  assert(worker.includes("queueChatPushDispatch"), "worker waitUntil dispatch");
  assert(worker.includes("if (!url || message.deletionType) return"), "deleted messages skip push");
  assert(!/queueChatPushDispatch\(.*tombstone/.test(worker), "no tombstone push");
  assert(worker.includes("replyToSenderUserId"), "validated reply sender from SQLite");
  const dispatch = fs.readFileSync("src/lib/chatPushDispatch.ts", "utf8");
  assert(dispatch.includes("loadEnabledDevicePushTokens"), "batch native tokens");
  assert(dispatch.includes("selectChatPushRecipients"), "one recipient resolve");
  assert(dispatch.includes("!prefLoad.ok") && dispatch.includes("return empty(true)"), "prefs fail-closed skip");
  assert(dispatch.includes("resolveChatNotifyMode(row.mode)"), "dispatch maps each user row");
  assert(!dispatch.includes("chatNotifyPrefMap"), "dispatch does not collapse prefs by roomId");
  const route = fs.readFileSync("src/app/api/chat/push-dispatch/route.ts", "utf8");
  assert(route.includes("verifyChatInternalRequest"), "HMAC only");
  assert(!route.includes("resolveAuthUser"), "no session on dispatch");
  assert(route.includes("replyToSenderUserId || body.replyToUserId"), "reply sender fallback kept");
  const httpPrefs = fs.readFileSync("src/app/api/chat/notification-prefs/route.ts", "utf8");
  assert(httpPrefs.includes("chatNotifyPrefMap(rows)"), "HTTP prefs still room-keyed for one user");
  const pref = fs.readFileSync("src/app/api/chat/rooms/[roomId]/notification/route.ts", "utf8");
  assert(pref.includes("canWriteChatNotifyPref"), "pref ACL");
  const client = fs.readFileSync("src/app/chat/ChatClient.tsx", "utf8");
  assert(client.includes("upsertVisibleChatRoom"), "optimistic after 200");
  assert(client.includes("fetchRoomsHttp"), "snapshot reconcile");
  const onboard = fs.readFileSync("src/components/ChatPushOnboarding.tsx", "utf8");
  assert(onboard.includes("registerNativePushDevice"), "android enable reuses plugin");
  assert(onboard.includes("/api/push/subscription"), "pwa subscribe reuses API");
  const fcm = fs.readFileSync("src/lib/fcmHttpV1.ts", "utf8");
  assert(fcm.includes("payload.tag ? { tag:"), "FCM android tag");
  assert(!fcm.includes("renotify"), "native FCM unchanged (no renotify)");
  const sw = fs.readFileSync("public/sw.js", "utf8");
  assert(sw.includes("if (parsed.tag)"), "PWA tag only when present");
  assert(sw.includes("options.renotify = true"), "PWA same-tag renotify");
  assert(!/silent:\s*true/.test(sw), "PWA no silent");
  assert(client.includes("chatNotifyHeaderLabel"), "header shows current notify mode");
  assert(client.includes("notifyPrefs[activeRoom.roomId] ?? DEFAULT_CHAT_NOTIFY_MODE"), "header uses room pref or default");
  assert(client.includes("[room.roomId]: prev"), "failed save rolls back pref");
  assert(client.includes("directorySnapshotReady"), "deep link waits for snapshot");
  assert(!/directorySnapshotReady:\s*directoryConnected/.test(client), "socket open is not snapshot ready");
  assert(!/directoryConnected \|\| \(\!loading && rooms\.length/.test(client), "no early ALL/team fallback");
  assert(client.includes("nextDirectorySnapshotReady"), "client uses snapshot transition helper");
  assert(client.includes('"connect_start"'), "new Directory generation invalidates ready");
  assert(client.includes('"authoritative_rooms"'), "HTTP/WS rooms arrays mark ready");
  assert(!/setDirectorySnapshotReady\(true\)/.test(client), "no raw ready=true without helper");
  const connectFn = client.slice(client.indexOf("const connectDirectory"));
  const urlGuard = connectFn.indexOf("if (!url) return");
  const invalidate = connectFn.indexOf('nextDirectorySnapshotReady(true, "connect_start")');
  assert(urlGuard >= 0 && invalidate > urlGuard, "invalidate only after URL starts connection");
  const fetchFn = client.slice(client.indexOf("const fetchRoomsHttp"));
  assert(fetchFn.includes("startedGen"), "HTTP rooms capture Directory generation");
  assert(fetchFn.includes("resolveDirectoryHttpRoomsApply"), "HTTP rooms use generation guard");
  assert(fetchFn.includes("dirGenRef.current"), "HTTP rooms compare current Directory generation");
  const capture = fetchFn.indexOf("const startedGen = dirGenRef.current");
  const awaitFetch = fetchFn.indexOf("await fetch(");
  const guard = fetchFn.indexOf("resolveDirectoryHttpRoomsApply");
  const applyCall = fetchFn.indexOf("applyRooms(data.rooms)");
  assert(
    capture >= 0 && awaitFetch > capture && guard > awaitFetch && applyCall > guard,
    "HTTP generation captured before fetch and checked before applyRooms"
  );
  const store = fs.readFileSync("src/lib/pushSubscriptionStore.ts", "utf8");
  assert(store.includes("disablePushSubscriptionsForOtherUsers"), "web account-switch disable others");
  const native = fs.readFileSync("src/lib/nativePushToken.ts", "utf8");
  assert(native.includes("disableDevicePushTokensForOtherUsers"), "native A→B regression kept");
}

section("web switch / exclusive");
{
  const exclusive = exclusiveChatWebPushRows(
    [
      { endpoint: "https://e", userId: 9 },
      { endpoint: "https://ok", userId: 40 },
    ],
    ["https://e"]
  );
  assert(exclusive.length === 1 && exclusive[0]?.userId === 40, "shared web endpoint skipped");
  assert(
    shouldSilentRebindWebPush({
      authenticated: true,
      nativePlugin: false,
      notificationPermission: "granted",
    }),
    "web rebind when already granted"
  );
  assert(
    !shouldSilentRebindWebPush({
      authenticated: true,
      nativePlugin: false,
      notificationPermission: "default",
    }),
    "no silent permission request"
  );
}

void extraAsync().then(() => {
  if (failed) {
    console.error(`\nFAILED ${failed} / ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
});

async function extraAsync() {
  const absent = await loadChatNotifyPrefs(
    {
      chatRoomNotificationPreference: {
        findMany: async () => [],
      },
    } as never,
    "all",
    [9, 40]
  );
  const mixed = await loadChatNotifyPrefs(
    {
      chatRoomNotificationPreference: {
        findMany: async () => [
          { userId: 9, roomId: "all", mode: "MENTIONS" },
          { userId: 40, roomId: "all", mode: "OFF" },
        ],
      },
    } as never,
    "all",
    [9, 40]
  );
  assert(mixed.ok === true && mixed.prefs["9"] === "MENTIONS", "same room user 9 MENTIONS");
  assert(mixed.ok === true && mixed.prefs["40"] === "OFF", "same room user 40 OFF");
  const replyRecipients = selectChatPushRecipients({
    event: {
      roomId: "all",
      seq: 5,
      senderUserId: 8,
      mentionAll: false,
      mentionUserIds: [],
      replyToUserId: 9,
    },
    candidateUserIds: [8, 9, 40],
    prefs: mixed.ok ? mixed.prefs : {},
  });
  assert(replyRecipients.join(",") === "9", "MENTIONS reply recipient is 9 only");
  const mentionRecipients = selectChatPushRecipients({
    event: {
      roomId: "all",
      seq: 6,
      senderUserId: 8,
      mentionAll: false,
      mentionUserIds: [9],
      replyToUserId: null,
    },
    candidateUserIds: [8, 9, 40],
    prefs: mixed.ok ? mixed.prefs : {},
  });
  assert(mentionRecipients.join(",") === "9", "MENTIONS direct mention recipient is 9 only");
  const dmMention = selectChatPushRecipients({
    event: {
      roomId: "dm_8_40",
      seq: 8,
      senderUserId: 8,
      mentionAll: false,
      mentionUserIds: [40],
      replyToUserId: null,
    },
    candidateUserIds: [8, 40],
    prefs: { "40": "MENTIONS" },
  });
  assert(dmMention.join(",") === "40", "MENTIONS DM peer mention recipient is 40");
  const offMention = selectChatPushRecipients({
    event: {
      roomId: "all",
      seq: 7,
      senderUserId: 8,
      mentionAll: false,
      mentionUserIds: [40],
      replyToUserId: 40,
    },
    candidateUserIds: [8, 9, 40],
    prefs: mixed.ok ? mixed.prefs : {},
  });
  assert(!offMention.includes(40), "OFF user excluded even for mention/reply");
  assert(!offMention.includes(8) && !replyRecipients.includes(8), "sender self-push none");

  assert(absent.ok === true && Object.keys(absent.prefs).length === 0, "prefs query ok empty");
  const absentRecipients = selectChatPushRecipients({
    event: {
      roomId: "all",
      seq: 3,
      senderUserId: 8,
      mentionAll: false,
      mentionUserIds: [],
      replyToUserId: null,
    },
    candidateUserIds: [8, 9],
    prefs: absent.ok ? absent.prefs : {},
  });
  assert(absentRecipients.join(",") === "9", "prefs row absent → ALL");

  const missing = await loadChatNotifyPrefs(
    {
      chatRoomNotificationPreference: {
        findMany: async () => {
          throw Object.assign(new Error("relation ChatRoomNotificationPreference does not exist"), {
            code: "P2021",
          });
        },
      },
    } as never,
    "all",
    [9]
  );
  assert(missing.ok === false && missing.reason === "store_missing", "prefs table missing → NO PUSH");

  const failedLoad = await loadChatNotifyPrefs(
    {
      chatRoomNotificationPreference: {
        findMany: async () => {
          throw new Error("timeout");
        },
      },
    } as never,
    "all",
    [9]
  );
  assert(failedLoad.ok === false && failedLoad.reason === "query_failed", "prefs DB failure → NO PUSH");

  const skipped = await dispatchChatPush(
    {
      chatRoomNotificationPreference: {
        findMany: async () => {
          throw new Error("timeout");
        },
      },
    } as never,
    {
      roomId: "all",
      seq: 4,
      senderUserId: 8,
      senderName: "홍",
      preview: "hi",
      mentionAll: false,
      mentionUserIds: [],
      replyToUserId: null,
      roomType: "ALL",
    },
    { eligibleUserIds: [8, 9], sendNative: async () => "sent" }
  );
  assert(skipped.recipients === 0 && skipped.skipped, "dispatch skips when prefs fail");

  const n = await disablePushSubscriptionsForOtherUsers(
    {
      pushSubscription: {
        updateMany: async () => ({ count: 1 }),
      },
    } as never,
    { userId: 2, endpoint: "https://e" }
  );
  assert(n === 1, "web subscription A→B account switch");

  const bad = await verifyChatInternalRequest(
    new Request("http://local/api/chat/push-dispatch", {
      method: "POST",
      headers: {
        [CHAT_INTERNAL_AUTH_HEADER]: "nope",
        [CHAT_INTERNAL_TS_HEADER]: String(Math.floor(Date.now() / 1000)),
      },
    }),
    "/api/chat/push-dispatch",
    { CHAT_INTERNAL_SECRET: "secret" } as NodeJS.ProcessEnv
  );
  assert(bad === false, "HMAC invalid request 401/403");

  const none = await verifyChatInternalRequest(
    new Request("http://local/api/chat/push-dispatch", { method: "POST" }),
    "/api/chat/push-dispatch",
    { CHAT_INTERNAL_SECRET: "secret" } as NodeJS.ProcessEnv
  );
  assert(none === false, "unauthenticated dispatch rejected");
}
