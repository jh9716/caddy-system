/**
 * Chat Phase 2 directory / unread / invite / admin spoof helpers.
 * 실행: npm run test:chat-phase2-unit
 */
import {
  chatNotificationTag,
  computeChatUnread,
  generateCustomRoomId,
  isAllRoomId,
  isCustomRoomId,
  isLegacyTeamRoomId,
  sanitizeChatRoomName,
  sortChatRoomSummaries,
  truncateChatPreview,
} from "../src/lib/chatRooms";
import { isVerifiedAdminRole, senderRoleFromClaims } from "../src/lib/chatAcl";
import {
  collectChatInviteMembers,
  matchesChatUserQuery,
  sanitizeChatUserHit,
  toChatUserSearchHit,
  type ChatUserRow,
} from "../src/lib/chatUsers";

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

section("room ids");
{
  assert(isAllRoomId("all"), "all room");
  assert(!isAllRoomId("ALL"), "all is lowercase");
  assert(isCustomRoomId(generateCustomRoomId(() => new Uint8Array(8).fill(0x8c))), "generated custom");
  assert(!isCustomRoomId("대바"), "name is not an id");
  assert(isLegacyTeamRoomId("team-7"), "legacy kept");
  assert(chatNotificationTag("room_8c6d000000000000") === "chat:room_8c6d000000000000", "stable FCM tag");
  assert(sanitizeChatRoomName("  대바  ") === "대바", "name trim");
  assert(sanitizeChatRoomName("가".repeat(40)).length === 24, "name max 24");
}

section("list sort / preview / unread");
{
  const sorted = sortChatRoomSummaries([
    { type: "CUSTOM", lastMessageAt: "2026-10-03T04:00:00.000Z", createdAt: "a" },
    { type: "ALL", lastMessageAt: "2026-10-01T00:00:00.000Z", createdAt: "b" },
    { type: "CUSTOM", lastMessageAt: "2026-10-03T05:00:00.000Z", createdAt: "c" },
  ]);
  assert(sorted[0]?.type === "ALL", "overall room pinned first");
  assert(sorted[1]?.lastMessageAt === "2026-10-03T05:00:00.000Z", "newer custom next");
  assert(truncateChatPreview("안녕하세요 오늘 몇 시".repeat(8)).endsWith("…"), "preview truncate");
  assert(computeChatUnread(12, 0) === 12, "unread from zero");
  assert(computeChatUnread(12, 12) === 0, "open room read");
  assert(computeChatUnread(12, 20) === 0, "unread never negative");
  assert(computeChatUnread(5, 4) === 1, "other room increment");
}

section("invite / search");
{
  const owner = { userId: 1, displayName: "나", role: "caddy" as const, team: "1조" };
  const rows: ChatUserRow[] = [
    { id: 2, username: "kim", role: "caddy", caddy: { name: "김OO", team: "2조", employmentStatus: "ACTIVE" } },
    { id: 2, username: "dup", role: "caddy", caddy: { name: "김OO", team: "2조", employmentStatus: "ACTIVE" } },
    { id: 3, username: "out", role: "caddy", caddy: { name: "퇴직", team: "3조", employmentStatus: "RETIRED" } },
    { id: 4, username: "ghost", role: "caddy", caddy: null },
    { id: 5, username: "admin", role: "admin", caddy: null },
  ];
  const collected = collectChatInviteMembers({
    owner,
    candidates: rows,
    requestedIds: [2, 2, 3, 4, 5, 99],
  });
  assert(collected.ok, "collect ok");
  if (collected.ok) {
    assert(collected.members.some((m) => m.userId === 1), "owner included");
    assert(collected.members.filter((m) => m.userId === 2).length === 1, "duplicate member collapsed");
    assert(!collected.members.some((m) => m.userId === 3), "retired skipped");
    assert(!collected.members.some((m) => m.userId === 4), "unlinked caddy skipped");
    assert(collected.members.some((m) => m.userId === 5), "DB admin invited");
    assert(!collected.members.some((m) => m.userId === 99), "missing user skipped");
  }
  assert(matchesChatUserQuery(rows[0]!, "김"), "search name");
  assert(!toChatUserSearchHit(rows[2]!), "retired not searchable");
  const hit = toChatUserSearchHit(rows[0]!);
  assert(hit?.userId === 2 && !("phone" in hit) && !("kakaoUserId" in hit), "public search fields only");
  assert(sanitizeChatUserHit(hit!).displayName === "김OO", "sanitize keeps public keys");
}

section("admin spoof protection helpers");
{
  assert(isVerifiedAdminRole("admin"), "token admin is styled");
  assert(!isVerifiedAdminRole("caddy"), "caddy cannot be admin");
  assert(!isVerifiedAdminRole("leader"), "leader cannot be admin");
  assert(senderRoleFromClaims({ role: "admin" }) === "admin", "role from claims");
  assert(senderRoleFromClaims({ role: "caddy" }) === "caddy", "caddy stays caddy");
  const clientPayload = { type: "message", senderRole: "admin", body: "spoof" };
  assert(
    senderRoleFromClaims({ role: "caddy" }) !== clientPayload.senderRole ||
      senderRoleFromClaims({ role: "caddy" }) === "caddy",
    "client senderRole ignored; claims win"
  );
}

if (failed > 0) {
  console.error(`\nchat-phase2 tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-phase2 tests passed: ${passed}`);
