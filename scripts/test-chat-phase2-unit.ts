/**
 * Chat Phase 2 directory / unread / invite / admin spoof helpers.
 * 실행: npm run test:chat-phase2-unit
 */
import {
  chatNotificationTag,
  clampChatReadSeq,
  computeChatUnread,
  customRoomIdFromClientRequest,
  generateCustomRoomId,
  isAllRoomId,
  isCustomRoomId,
  isLegacyTeamRoomId,
  sanitizeChatRoomName,
  sortChatRoomSummaries,
  truncateChatPreview,
} from "../src/lib/chatRooms";
import {
  getChatInternalSecret,
  signDirectoryCreateGrant,
  verifyDirectoryCreateGrant,
} from "../src/lib/chatDirectoryGrant";
import { CHAT_TOKEN_TTL_SEC } from "../src/lib/chatToken";
import { isVerifiedAdminRole, senderRoleFromClaims } from "../src/lib/chatAcl";
import { MAX_CUSTOM_MEMBERS } from "../src/lib/chatRooms";
import {
  CHAT_USERS_ALL_TAKE,
  collectChatInviteMembers,
  listInvitableChatUsers,
  matchesChatUserQuery,
  sanitizeChatUserHit,
  toChatUserSearchHit,
  type ChatUserRow,
  type ChatUserSearchHit,
} from "../src/lib/chatUsers";
import {
  clearInviteIds,
  filterInviteUsers,
  invitePoolExcludingOwner,
  inviteSelectionCount,
  isRoleFullySelected,
  isTeamFullySelected,
  selectAllInviteIds,
  toggleInviteId,
  toggleRoleInviteIds,
  toggleTeamInviteIds,
  uniqueInviteIds,
  visibleInviteRoles,
  visibleInviteTeams,
} from "../src/lib/chatInviteSelection";

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

async function main() {
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
  assert(clampChatReadSeq(999999, 12) === 12, "malicious read seq clamped");
  assert(clampChatReadSeq(7, 12) === 7, "normal read kept");
  assert(clampChatReadSeq(-3, 12) === 0, "negative read zeroed");
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
  assert(MAX_CUSTOM_MEMBERS >= 250, "custom room can invite ~250");
  assert(CHAT_USERS_ALL_TAKE >= 250, "scope=all take covers 250");
}

section("bulk invite selection");
{
  const pool: ChatUserSearchHit[] = [
    { userId: 1, displayName: "나", team: "7조", role: "caddy", active: true },
    { userId: 10, displayName: "신정훈", team: "7조", role: "caddy", active: true },
    { userId: 11, displayName: "7조원", team: "7조", role: "caddy", active: true },
    { userId: 20, displayName: "8조원", team: "8조", role: "caddy", active: true },
    { userId: 30, displayName: "리더", team: "7조", role: "leader", active: true },
    { userId: 40, displayName: "관리자", team: "-", role: "admin", active: true },
    { userId: 50, displayName: "퇴직", team: "7조", role: "caddy", active: false },
  ];
  const candidates = invitePoolExcludingOwner(pool, 1);
  assert(!candidates.some((u) => u.userId === 1), "owner not in invite UI");
  assert(!candidates.some((u) => !u.active), "inactive excluded from UI pool");
  assert(visibleInviteTeams(candidates).map((t) => t.team).join(",") === "7조,8조", "only existing teams");
  assert(
    visibleInviteRoles(candidates)
      .map((r) => r.label)
      .join(",") === "캐디 전체,리더,관리자",
    "only existing roles"
  );
  const all = selectAllInviteIds(candidates);
  assert(all.length === 5 && !all.includes(1), "전체 선택 skips owner");
  assert(inviteSelectionCount(all) === 5, "count is extra members");
  assert(clearInviteIds().length === 0, "선택 해제");
  const team7 = toggleTeamInviteIds([], candidates, "7조");
  assert(team7.includes(10) && team7.includes(11) && team7.includes(30) && !team7.includes(20), "7조 selects that team");
  const team78 = toggleTeamInviteIds(team7, candidates, "8조");
  assert(team78.includes(20) && team78.includes(10), "7조+8조");
  const team7off = toggleTeamInviteIds(team78, candidates, "7조");
  assert(!team7off.includes(10) && team7off.includes(20), "7조 toggle off keeps 8조");
  const caddies = toggleRoleInviteIds([], candidates, "caddy");
  assert(caddies.includes(10) && caddies.includes(20) && !caddies.includes(30), "캐디 전체 excludes leaders");
  const leaders = toggleRoleInviteIds(caddies, candidates, "leader");
  assert(leaders.includes(30), "리더 chip is separate");
  const minusJung = toggleInviteId(team7, 10);
  assert(!minusJung.includes(10) && minusJung.includes(11), "quick-select then exclude 신정훈");
  const searched = filterInviteUsers(candidates, "신정");
  assert(searched.map((u) => u.userId).join(",") === "10", "search filters list");
  const kept = toggleInviteId(team7, 20);
  assert(kept.includes(11) && kept.includes(20), "selection SoT survives search");
  assert(isTeamFullySelected(team7, candidates, "7조"), "7조 fully selected");
  assert(!isTeamFullySelected(minusJung, candidates, "7조"), "partial 7조 not fully selected");
  assert(isRoleFullySelected(caddies, candidates, "caddy"), "caddy role fully selected");
  const emptyTeams = visibleInviteTeams([]);
  assert(emptyTeams.length === 0, "no invented 1-12조");

  const many: ChatUserRow[] = [];
  for (let i = 2; i <= 251; i++) {
    many.push({
      id: i,
      username: `u${i}`,
      role: i === 2 ? "admin" : "caddy",
      caddy: { name: `U${i}`, team: `${((i % 12) || 12)}조`, employmentStatus: "ACTIVE" },
    });
  }
  many.push({
    id: 999,
    username: "retired",
    role: "caddy",
    caddy: { name: "퇴직", team: "1조", employmentStatus: "RETIRED" },
  });
  const listed = listInvitableChatUsers(many);
  assert(listed.length === 250, "250-scale invite pool");
  assert(listed.every((u) => !("phone" in u) && !("kakaoUserId" in u)), "no sensitive fields at 250");
  const collected = collectChatInviteMembers({
    owner: { userId: 1, displayName: "나", role: "admin", team: "-" },
    candidates: many,
    requestedIds: [...listed.map((u) => u.userId), 1, listed[0]!.userId],
  });
  assert(collected.ok, "250 + owner within cap");
  if (collected.ok) {
    assert(collected.members.length === 251, "owner + 250 extras");
    assert(uniqueInviteIds(collected.members.map((m) => m.userId)).length === 251, "no duplicate members");
    assert(!collected.members.some((m) => m.userId === 999), "retired excluded from create");
  }
}

section("create idempotency / internal secret");
{
  const a = await customRoomIdFromClientRequest(1, "cr-same");
  const b = await customRoomIdFromClientRequest(1, "cr-same");
  const c = await customRoomIdFromClientRequest(2, "cr-same");
  assert(!!a && a === b, "same owner+request id");
  assert(!!c && c !== a, "other owner different room");
  assert(CHAT_TOKEN_TTL_SEC === 1800, "recommended 30 min TTL");
  process.env.CHAT_AUTH_SECRET = process.env.CHAT_AUTH_SECRET || "phase1-local-test-only";
  delete process.env.CHAT_INTERNAL_SECRET;
  assert(getChatInternalSecret() === process.env.CHAT_AUTH_SECRET, "fallback to CHAT_AUTH_SECRET");
  process.env.CHAT_INTERNAL_SECRET = "internal-only-secret";
  assert(getChatInternalSecret() === "internal-only-secret", "prefers CHAT_INTERNAL_SECRET");
  const now = Math.floor(Date.now() / 1000);
  const grant = await signDirectoryCreateGrant({
    v: 1,
    op: "create_room",
    roomId: "room_0123456789abcdef",
    name: "대바",
    ownerUserId: 1,
    members: [{ userId: 1, displayName: "A", role: "caddy", team: "1조" }],
    iat: now,
    exp: now + 60,
  });
  const ok = await verifyDirectoryCreateGrant(grant, "internal-only-secret", now + 1);
  const no = await verifyDirectoryCreateGrant(grant, process.env.CHAT_AUTH_SECRET, now + 1);
  assert(!!ok && ok.roomId === "room_0123456789abcdef", "grant verifies with internal secret");
  assert(no == null, "identity secret cannot mint directory grant when internal is set");
  delete process.env.CHAT_INTERNAL_SECRET;
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
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
