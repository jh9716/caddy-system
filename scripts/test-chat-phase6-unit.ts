/**
 * Chat Phase 6 — room notify prefs, recipients, collapse, deep link, onboard, DM optimistic.
 * 실행: npm run test:chat-phase6-unit
 */
import fs from "node:fs";
import { chatNotificationTag } from "../src/lib/chatRooms";
import {
  canWriteChatNotifyPref,
  DEFAULT_CHAT_NOTIFY_MODE,
  parseChatNotifyMode,
  resolveChatNotifyMode,
} from "../src/lib/chatNotificationPref";
import {
  candidateUserIdsForRoom,
  isChatPushableEvent,
  selectChatPushRecipients,
  shouldNotifyChatUser,
} from "../src/lib/chatPushRecipients";
import { buildChatPushPayload, chatPushOpenPath } from "../src/lib/chatPushMessage";
import {
  parseChatDeepLinkRoomId,
  resolveChatDeepLinkAction,
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
  assert(
    resolveChatDeepLinkAction({
      requestedRoomId: "room_0123456789abcdef",
      rooms: [],
      directoryReady: true,
    }) === "fallback",
    "forbidden fallback"
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
  const dispatch = fs.readFileSync("src/lib/chatPushDispatch.ts", "utf8");
  assert(dispatch.includes("loadEnabledDevicePushTokens"), "batch native tokens");
  assert(dispatch.includes("selectChatPushRecipients"), "one recipient resolve");
  const route = fs.readFileSync("src/app/api/chat/push-dispatch/route.ts", "utf8");
  assert(route.includes("verifyChatInternalRequest"), "HMAC only");
  assert(!route.includes("resolveAuthUser"), "no session on dispatch");
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
}

if (failed) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
