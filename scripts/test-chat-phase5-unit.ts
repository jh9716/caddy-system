/**
 * Chat Phase 5 — messenger UX, profile, DM identity/ACL.
 * 실행: npm run test:chat-phase5-unit
 */
import {
  canonicalDmRoomId,
  isDmRoomId,
  parseDmRoomId,
  resolveMentionAll,
} from "../cloudflare/verthill-chat/src/protocol";
import { planCanonicalDmCreate } from "../cloudflare/verthill-chat/src/dmMembership";
import { resolveChatRoomAccess as workerAccess } from "../cloudflare/verthill-chat/src/token";
import { resolveChatRoomAccess } from "../src/lib/chatAcl";
import {
  CHAT_DM_OPEN_FAILED,
  chatWsDiagnoseUrl,
  chatWsFailureCode,
  diagnoseChatWsFailure,
  formatChatClientError,
  parseChatClientErrorCode,
  sanitizeChatErrorCode,
} from "../src/lib/chatDmClient";
import { sortChatRoomSummaries } from "../src/lib/chatRooms";
import {
  applyDeletedLine,
  applyHiddenSeq,
  displayTombstone,
  mergeChatLines,
} from "../src/lib/chatPhase4";
import {
  canProfileMention,
  chatAuthorLine,
  chatDateKey,
  defaultAvatarInitial,
  isNearChatBottom,
  isVisibleChatListRoom,
  publicChatProfile,
  roomListTitle,
  shouldShowAuthorMeta,
  shouldShowDateDivider,
  shouldShowJumpButton,
} from "../src/lib/chatPhase5";
import { resolveAndroidSystemBack } from "../src/lib/androidSystemBack";
import fs from "node:fs";

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

function v2(userId = 8) {
  return {
    v: 2 as const,
    userId,
    displayName: "신정훈",
    role: "caddy" as const,
    team: "7조",
    sv: 1,
    iat: 1,
    exp: 9_999_999_999,
  };
}

section("DM identity");
{
  assert(canonicalDmRoomId(40, 8) === "dm_8_40", "A→B canonical");
  assert(canonicalDmRoomId(8, 40) === "dm_8_40", "B→A same room");
  assert(canonicalDmRoomId(8, 8) == null, "self DM rejected");
  assert(parseDmRoomId("dm_40_8") == null, "unsorted id rejected");
  assert(isDmRoomId("dm_8_40") && !isDmRoomId("room_0123456789abcdef"), "dm vs custom");
}

section("canonical DM membership plan");
{
  const pair = { roomId: "dm_8_40", ownerUserId: 8, grantMemberIds: [40, 8] };
  assert(planCanonicalDmCreate({ ...pair, existingType: null, existingMemberIds: [] }).action === "create", "new pair creates");
  assert(
    planCanonicalDmCreate({ ...pair, existingType: "DM", existingMemberIds: [8, 40] }).action === "idempotent",
    "healthy existing is idempotent"
  );
  const repaired = planCanonicalDmCreate({
    ...pair,
    ownerUserId: 40,
    grantMemberIds: [40, 8],
    existingType: "DM",
    existingMemberIds: [8],
  });
  assert(repaired.action === "repair", "missing peer is repairable");
  assert(repaired.action === "repair" && repaired.add.join(",") === "40", "repair adds only the missing peer");
  const empty = planCanonicalDmCreate({
    ...pair,
    existingType: "DM",
    existingMemberIds: [],
  });
  assert(empty.action === "repair" && empty.add.join(",") === "8,40", "zero members still repairable by valid grant");
  assert(
    planCanonicalDmCreate({
      roomId: "dm_8_40",
      ownerUserId: 8,
      grantMemberIds: [8, 99],
      existingType: "DM",
      existingMemberIds: [8],
    }).error === "dm_pair_mismatch",
    "wrong canonical pair cannot repair"
  );
  assert(
    planCanonicalDmCreate({
      roomId: "dm_8_8",
      ownerUserId: 8,
      grantMemberIds: [8, 8],
      existingType: null,
      existingMemberIds: [],
    }).error === "invalid_room",
    "self DM room id rejected"
  );
  assert(
    planCanonicalDmCreate({
      roomId: "room_0123456789abcdef",
      ownerUserId: 8,
      grantMemberIds: [8, 40],
      existingType: "CUSTOM",
      existingMemberIds: [8, 40],
    }).error === "invalid_room",
    "custom room is not a DM repair target"
  );
  assert(
    planCanonicalDmCreate({
      roomId: "dm_8_40",
      ownerUserId: 8,
      grantMemberIds: [8, 40],
      existingType: "CUSTOM",
      existingMemberIds: [8],
    }).error === "room_exists",
    "non-DM existing row is not rewritten"
  );
}

section("DM client error codes");
{
  assert(formatChatClientError(CHAT_DM_OPEN_FAILED, "room_forbidden") === `${CHAT_DM_OPEN_FAILED} [room_forbidden]`, "friendly + code");
  assert(parseChatClientErrorCode(`${CHAT_DM_OPEN_FAILED} [room_forbidden]`) === "room_forbidden", "parse code");
  assert(sanitizeChatErrorCode("room_forbidden / secret") === "unknown", "reject unsafe codes");
  assert(sanitizeChatErrorCode("https://evil") === "unknown", "reject urls");
  assert(chatWsFailureCode({ closeCode: 4008 }) === "stale_session", "close 4008 is stale_session");
  assert(chatWsFailureCode({ timeout: true }) === "ws_timeout", "timeout code");
  assert(chatWsDiagnoseUrl("wss://chat.example/ws?room=dm_8_40&token=abc")?.startsWith("https://") === true, "diagnose uses http");
}

function runDmDiagnoseTests() {
  return diagnoseChatWsFailure(
    "wss://chat.example/ws?room=dm_8_40&token=hidden",
    1006,
    async () =>
      new Response(JSON.stringify({ error: "room_forbidden" }), {
        status: 403,
        headers: { "content-type": "application/json" },
      })
  ).then((forbidden) => {
    section("DM WS diagnose");
    assert(forbidden === "room_forbidden", "HTTP diagnose returns worker code");
    return diagnoseChatWsFailure(
      "wss://chat.example/ws?room=dm_8_40&token=hidden",
      1006,
      async () => {
        throw new Error("offline");
      }
    );
  }).then((fallback) => {
    assert(fallback === "ws_1006", "diagnose falls back to close code");
  });
}

section("DM ACL");
{
  const room = "dm_8_40";
  assert(
    resolveChatRoomAccess({ claims: v2(8), roomId: room, isMember: true }).ok,
    "member can enter DM"
  );
  assert(
    !resolveChatRoomAccess({ claims: v2(99), roomId: room, isMember: false }).ok,
    "outsider rejected"
  );
  assert(
    !resolveChatRoomAccess({
      claims: { ...v2(1), role: "admin" },
      roomId: room,
      isMember: false,
    }).ok,
    "admin outsider cannot peek DM"
  );
  assert(resolveMentionAll(true, "admin", room) === false, "DM mentionAll rejected");
  assert(resolveMentionAll(true, "admin", "all") === true, "all-room mentionAll still admin/leader");
  assert(
    workerAccess({
      claims: v2(8),
      roomId: room,
      isMember: true,
      isAll: false,
      isCustom: false,
      isLegacy: false,
      isDm: true,
    }).ok,
    "worker DM member ok"
  );
}

section("group / all regression");
{
  assert(
    resolveChatRoomAccess({ claims: v2(8), roomId: "all", isMember: false }).ok,
    "all room still open"
  );
  assert(
    resolveChatRoomAccess({
      claims: v2(8),
      roomId: "room_0123456789abcdef",
      isMember: true,
    }).ok,
    "custom member ok"
  );
  assert(
    !resolveChatRoomAccess({
      claims: v2(8),
      roomId: "room_0123456789abcdef",
      isMember: false,
    }).ok,
    "custom outsider still forbidden"
  );
  const sorted = sortChatRoomSummaries([
    { type: "CUSTOM", lastMessageAt: "2026-10-04T02:00:00.000Z", createdAt: "a" },
    { type: "ALL", lastMessageAt: "2026-10-01T00:00:00.000Z", createdAt: "b" },
    { type: "DM", lastMessageAt: "2026-10-04T03:00:00.000Z", createdAt: "c" },
  ]);
  assert(sorted[0]!.type === "ALL", "전체방 remains pinned first");
  assert(isVisibleChatListRoom("ALL") && isVisibleChatListRoom("CUSTOM"), "group rooms stay listed");
  assert(isVisibleChatListRoom("DM"), "DM stays in directory list");
  assert(!isVisibleChatListRoom("team-1") && !isVisibleChatListRoom("LEGACY"), "legacy team rooms stay hidden");
}

section("profile privacy / labels");
{
  const profile = publicChatProfile({
    userId: 8,
    displayName: "신정훈",
    team: "7조",
    role: "caddy",
  });
  assert(profile.authorLine === "7조 신정훈", "caddy team + name");
  assert(profile.roleLabel === "캐디", "role label");
  assert(!("userId" in profile) && !("username" in profile), "no ids/username");
  assert(chatAuthorLine({ displayName: "이기흥", role: "admin" }) === "이기흥", "admin name only");
  assert(defaultAvatarInitial("신정훈") === "신", "default avatar initial");
  assert(
    canProfileMention({ roomId: "all", isMember: true, targetUserId: 6, myUserId: 8 }),
    "all-room mention allowed"
  );
  assert(
    canProfileMention({ roomId: "dm_8_40", isMember: true, targetUserId: 40, myUserId: 8 }),
    "DM peer profile mention allowed"
  );
  assert(
    !canProfileMention({ roomId: "dm_8_40", isMember: true, targetUserId: 8, myUserId: 8 }),
    "DM self profile mention hidden"
  );
  assert(
    !canProfileMention({ roomId: "dm_8_40", isMember: false, targetUserId: 40, myUserId: 8 }),
    "DM non-member profile mention hidden"
  );
}

section("author grouping / date / jump");
{
  const same = shouldShowAuthorMeta({
    mine: false,
    senderUserId: 8,
    prevSenderUserId: 8,
    sentAt: "2026-10-04T01:10:00.000Z",
    prevSentAt: "2026-10-04T01:09:00.000Z",
  });
  assert(!same, "grouped same author hides header");
  assert(
    shouldShowDateDivider("2026-10-03T15:00:00.000Z", "2026-10-04T01:00:00.000Z"),
    "new local day shows divider"
  );
  assert(
    !shouldShowDateDivider("2026-10-04T01:00:00.000Z", "2026-10-04T08:00:00.000Z") ||
      chatDateKey("2026-10-04T01:00:00.000Z") === chatDateKey("2026-10-04T08:00:00.000Z"),
    "same local day no duplicate divider"
  );
  assert(isNearChatBottom({ scrollHeight: 1000, scrollTop: 960, clientHeight: 50 }), "near bottom");
  assert(
    !isNearChatBottom({ scrollHeight: 1000, scrollTop: 10, clientHeight: 50 }),
    "scrolled up"
  );
  assert(shouldShowJumpButton({ stuckToBottom: false, unseenCount: 2 }), "jump when unseen");
  assert(!shouldShowJumpButton({ stuckToBottom: true, unseenCount: 2 }), "no jump at bottom");
}

section("tombstone / reply / unread title");
{
  assert(displayTombstone("everyone") === "메시지가 삭제되었습니다.", "everyone tombstone");
  const hidden = applyHiddenSeq(
    [{ seq: 2, replyToSeq: 1, replyTo: { seq: 1, senderUserId: 1, sender: "a", preview: "비밀", state: "ok" as const } }],
    1
  );
  assert(hidden[0]!.replyTo?.preview !== "비밀", "hidden reply stays redacted");
  const deleted = applyDeletedLine(
    [
      {
        clientMessageId: "a",
        senderUserId: 1,
        sender: "a",
        senderRole: "caddy",
        body: "비밀",
        sentAt: "t",
        seq: 3,
        mentions: [8],
        mentionAll: false,
      },
    ],
    { seq: 3, deletionType: "everyone", deletedAt: "now" }
  );
  assert(deleted[0]!.body === "", "deleted body cleared");
  const merged = mergeChatLines([{ clientMessageId: "a", seq: 1 }], [{ clientMessageId: "a", seq: 1 }]);
  assert(merged.length === 1, "sync merge no dup");
  assert(roomListTitle({ type: "ALL", name: "x" }) === "전체 채팅방", "all title");
  assert(
    roomListTitle({ type: "DM", name: "DM", peerDisplayName: "신정훈", peerTeam: "7조", peerRole: "caddy" }) ===
      "7조 신정훈",
    "DM list title from peer"
  );
}

section("android back / source");
{
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      chatOverlayOpen: true,
      inChatRoom: true,
      pathname: "/chat",
      canGoBack: true,
    }) === "close-chat-overlay",
    "overlay including profile closes first"
  );
  const client = fs.readFileSync("src/app/chat/ChatClient.tsx", "utf8");
  const css = fs.readFileSync("src/app/globals.css", "utf8");
  const worker = fs.readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
  const dir = fs.readFileSync("cloudflare/verthill-chat/src/directory.ts", "utf8");
  const dmPlan = fs.readFileSync("cloudflare/verthill-chat/src/dmMembership.ts", "utf8");
  const api = fs.readFileSync("src/app/api/chat/dm/route.ts", "utf8");
  assert(client.includes("vh-chat-profile-sheet"), "profile sheet");
  assert(client.includes("/api/chat/dm"), "DM start from profile");
  assert(client.includes("isVisibleChatListRoom"), "list keeps Directory DM rows");
  assert(
    !client.includes('r.type === "ALL" || r.type === "CUSTOM"'),
    "applyRooms no longer drops DM"
  );
  const startDmBlock = client.slice(
    client.indexOf("async function startDm"),
    client.indexOf("async function handleCreate")
  );
  assert(startDmBlock.includes("fetchRoomsHttp"), "startDm refreshes Directory snapshot");
  assert(startDmBlock.includes("formatChatClientError"), "startDm keeps deterministic error codes");
  assert(startDmBlock.includes("CHAT_DM_OPEN_FAILED"), "open failure stays user-safe");
  assert(!startDmBlock.includes("rollbackOptimisticChatRoom"), "directory refresh cannot hide created DM");
  assert(client.includes("waitForOpen: true"), "openRoom waits for WS authorize");
  assert(client.includes("data-chat-error-code"), "error code is inspectable");
  assert(client.includes("diagnoseChatWsFailure"), "failed WS is diagnosed without token logs");
  assert(api.includes("repaired: data?.repaired === true"), "API forwards repair flag");
  assert(client.includes("vh-chat-date"), "date divider");
  assert(client.includes("vh-chat-tombstone"), "compact tombstone");
  assert(css.includes("max-width: 76%"), "bubble width");
  assert(!css.includes("align-self: stretch;\n  max-width: 100%;"), "no full-width admin card");
  assert(worker.includes("isDmRoomId"), "worker DM ACL");
  assert(dir.includes("handleInternalCreateDm"), "directory DM create");
  assert(dir.includes("planCanonicalDmCreate"), "directory uses shared DM plan");
  assert(dmPlan.includes("dm_pair_mismatch"), "pair spoof rejected");
  assert(api.includes("self_dm"), "API rejects self DM");
  assert(api.includes("canonicalDmRoomId"), "API uses server pair");
  assert(!api.includes("phone"), "DM API no phone");
  const schema = fs.readFileSync("prisma/schema.prisma", "utf8");
  assert(!/model\s+ChatMessage/.test(schema), "no ChatMessage neon table");
  assert(/model ChatRoomNotificationPreference/.test(schema), "pref table is additive");
  const wrangler = fs.readFileSync("cloudflare/verthill-chat/wrangler.jsonc", "utf8");
  assert(!wrangler.includes("v3"), "no new DO class");
}

runDmDiagnoseTests()
  .catch((err) => {
    assert(false, `diagnose tests threw: ${err instanceof Error ? err.message : String(err)}`);
  })
  .then(() => {
    if (failed > 0) {
      console.error(`\nchat-phase5 tests failed: ${failed} (passed ${passed})`);
      process.exit(1);
    }
    console.log(`\nchat-phase5 tests passed: ${passed}`);
  });
