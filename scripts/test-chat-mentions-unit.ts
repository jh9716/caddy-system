/**
 * Chat Phase 3 @mention helpers / protocol / spoof.
 * 실행: npm run test:chat-mentions-unit
 */
import {
  MAX_MENTIONS,
  MAX_MENTION_RAW,
  MENTION_ALL_LABEL,
  canMentionAll,
  countMentionNeedles,
  filterMentionSuggestions,
  filterMentionsToMembers,
  insertMentionToken,
  isSelfMentioned,
  mentionQueryAtCursor,
  mentionsToWire,
  normalizeMentionUserIds,
  reconcileComposerMentions,
  reconcileMentionAll,
  resolveMentionAll,
  splitMentionBody,
} from "../src/lib/chatMentions";
import {
  listInvitableChatUsers,
  type ChatUserRow,
} from "../src/lib/chatUsers";
import { canMentionAll as workerCanMentionAll } from "../cloudflare/verthill-chat/src/protocol";
import {
  filterMentionsToMembers as workerFilterMembers,
  normalizeMentionUserIds as workerNormalize,
  resolveMentionAll as workerResolveAll,
  validateIncomingMessage,
} from "../cloudflare/verthill-chat/src/protocol";
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

function read(path: string) {
  return fs.readFileSync(path, "utf8");
}

section("normalize / abuse");
{
  assert(normalizeMentionUserIds([1, 1, 2, 0, -3, 1.5, "x"]).join(",") === "1,2", "dedupe + positive ints");
  assert(
    mentionsToWire([{ userId: 9 }, { userId: 9 }, 8]).map((m) => m.userId).join(",") === "9,8",
    "object or number ids"
  );
  assert(normalizeMentionUserIds(new Array(1001).fill(1)).length === 0, "1000+ raw mentions ignored");
  assert(normalizeMentionUserIds(Array.from({ length: 40 }, (_, i) => i + 1)).length === MAX_MENTIONS, "cap 20");
  assert(MAX_MENTION_RAW === 100, "raw abuse cutoff 100");
  assert(workerNormalize([3, 3, 0]).join(",") === "3", "worker normalize matches");
}

section("mentionAll auth");
{
  assert(canMentionAll("admin") && canMentionAll("leader"), "admin/leader can @전체");
  assert(!canMentionAll("caddy") && !canMentionAll("adminx"), "caddy cannot @전체");
  assert(resolveMentionAll(true, "admin") === true, "admin mentionAll accepted");
  assert(resolveMentionAll(true, "leader") === true, "leader mentionAll accepted");
  assert(resolveMentionAll(true, "caddy") === false, "caddy mentionAll spoof dropped");
  assert(resolveMentionAll("true", "admin") === false, "string true is not mentionAll");
  assert(workerCanMentionAll("caddy") === false, "worker caddy cannot mentionAll");
  assert(workerResolveAll(true, "caddy") === false, "worker spoof mentionAll false");
}

section("custom room members");
{
  assert(filterMentionsToMembers([1, 2, 9], [1, 2]).join(",") === "1,2", "non-member dropped");
  assert(filterMentionsToMembers([1], null).join(",") === "1", "all-room no member filter");
  assert(filterMentionsToMembers([1, 2], []).join(",") === "", "directory failure fail-closed");
  assert(workerFilterMembers([4, 5], [5]).join(",") === "5", "worker member filter");
}

section("composer query / insert / delete");
{
  assert(mentionQueryAtCursor("@", 1)?.query === "", "@ opens query");
  assert(mentionQueryAtCursor("@신", 2)?.query === "신", "@신 filters");
  assert(mentionQueryAtCursor("안녕 @한", 6)?.query === "한", "mid-text query");
  assert(mentionQueryAtCursor("email@x", 7) == null, "email @ is not mention");
  const inserted = insertMentionToken("@신", 2, "신정훈");
  assert(inserted.text === "@신정훈 ", "insert replaces query");
  const tokens = reconcileComposerMentions("@신정훈 확인", [
    { userId: 10, label: "신정훈" },
    { userId: 11, label: "한상준" },
  ]);
  assert(tokens.length === 1 && tokens[0]!.userId === 10, "deleted mention token removed");
  assert(
    reconcileComposerMentions("신정훈 확인", [{ userId: 10, label: "신정훈" }]).length === 0,
    "plain name is not a mention"
  );
  const same = reconcileComposerMentions("@신정훈 @신정훈 ", [
    { userId: 10, label: "신정훈" },
    { userId: 20, label: "신정훈" },
  ]);
  assert(same.map((t) => t.userId).join(",") === "10,20", "same-name tokens stay distinct");
  const oneLeft = reconcileComposerMentions("@신정훈 확인", [
    { userId: 10, label: "신정훈" },
    { userId: 20, label: "신정훈" },
  ]);
  assert(oneLeft.length === 1 && oneLeft[0]!.userId === 10, "one leftover same-name keeps first token");
  assert(countMentionNeedles("@신정훈.", "신정훈") === 1, "punctuation still a token");
  assert(reconcileMentionAll("@전체 확인", true) === true, "@전체 kept");
  assert(reconcileMentionAll("전체 확인", true) === false, "plain 전체 not mentionAll");
  assert(
    reconcileComposerMentions("@신정 확인", [{ userId: 10, label: "신정훈" }]).length === 0,
    "partial name edit drops mention"
  );
  assert(
    reconcileComposerMentions("@신정훈 확인", []).length === 0,
    "typed @name without pick is not a mention"
  );
  assert(
    reconcileComposerMentions("안녕 @신정X훈 확인", [{ userId: 10, label: "신정훈" }]).length === 0,
    "caret edit inside token drops mention"
  );
  assert(
    reconcileComposerMentions("@신정훈", [{ userId: 10, label: "신정훈" }]).map((t) => t.userId).join(",") === "10",
    "trim/end-of-string still a token"
  );
  const dedupedPick = reconcileComposerMentions("@신정훈 @신정훈 ", [
    { userId: 10, label: "신정훈" },
    { userId: 10, label: "신정훈" },
  ]);
  assert(dedupedPick.map((t) => t.userId).join(",") === "10", "same userId picked twice dedupes");
  assert(reconcileMentionAll("@전체 확인", false) === false, "typed @전체 without pick is not mentionAll");
  const between = reconcileComposerMentions("@신정훈 그리고 @한상준 확인", [
    { userId: 10, label: "신정훈" },
    { userId: 11, label: "한상준" },
  ]);
  assert(between.map((t) => t.userId).join(",") === "10,11", "text between mentions keeps both");
}

section("autocomplete");
{
  const people = [
    { userId: 1, displayName: "신정훈", team: "7조", role: "caddy" },
    { userId: 2, displayName: "신정훈", team: "3조", role: "caddy" },
    { userId: 3, displayName: "한상준", team: "1조", role: "leader" },
  ];
  const caddyHits = filterMentionSuggestions({
    candidates: people,
    query: "신",
    canMentionAll: false,
  });
  assert(caddyHits.every((h) => h.kind === "user"), "caddy list has no @전체");
  assert(caddyHits.some((h) => h.secondary === "7조") && caddyHits.some((h) => h.secondary === "3조"), "same-name + team");
  const adminHits = filterMentionSuggestions({
    candidates: people,
    query: "",
    canMentionAll: true,
  });
  assert(adminHits[0]?.kind === "all" && adminHits[0].displayName === MENTION_ALL_LABEL, "@전체 first for admin");
  const mixed = filterMentionSuggestions({
    candidates: [
      { userId: 1, displayName: "admin", team: "-", role: "admin" },
      { userId: 6, displayName: "이기흥", team: "-", role: "admin" },
      { userId: 2, displayName: "ghineung", team: "-", role: "admin" },
      { userId: 18, displayName: "신정훈", team: "7조", role: "caddy" },
      { userId: 27, displayName: "한상준", team: "7조", role: "caddy" },
      { userId: 3, displayName: "대시조장", team: "9조", role: "leader" },
    ],
    query: "",
    canMentionAll: true,
  });
  const mixedUsers = mixed.filter((h) => h.kind === "user");
  const firstCaddy = mixedUsers.findIndex((h) => h.role === "caddy");
  const firstLeader = mixedUsers.findIndex((h) => h.role === "leader");
  const firstAdmin = mixedUsers.findIndex((h) => h.role === "admin");
  assert(mixedUsers[0]?.role === "caddy", "empty @ shows caddies before admins");
  assert(firstCaddy >= 0 && firstCaddy < firstLeader, "caddy before leader");
  assert(firstLeader >= 0 && firstLeader < firstAdmin, "leader before admin");
  assert(mixedUsers.some((h) => h.displayName === "신정훈"), "active caddy appears");
  assert(mixedUsers.some((h) => h.displayName === "대시조장"), "leader appears");
  assert(mixedUsers.some((h) => h.displayName === "이기흥"), "real hangul admin kept");
  assert(mixedUsers.some((h) => h.displayName === "ghineung"), "latin admin kept in suggestions");
  const shin = filterMentionSuggestions({
    candidates: [
      { userId: 1, displayName: "admin", team: "-", role: "admin" },
      { userId: 18, displayName: "신정훈", team: "7조", role: "caddy" },
    ],
    query: "신",
    canMentionAll: false,
  });
  assert(shin.some((h) => h.displayName === "신정훈"), "Korean name search finds caddy");
  const lee = filterMentionSuggestions({
    candidates: [
      { userId: 18, displayName: "신정훈", team: "7조", role: "caddy" },
      { userId: 6, displayName: "이기흥", team: "-", role: "admin" },
    ],
    query: "이기흥",
    canMentionAll: false,
  });
  assert(lee.some((h) => h.displayName === "이기흥"), "admin Korean name search works");
  const caddyToAdmin = filterMentionSuggestions({
    candidates: [
      { userId: 6, displayName: "이기흥", team: "-", role: "admin" },
      { userId: 18, displayName: "신정훈", team: "7조", role: "caddy" },
    ],
    query: "이기",
    canMentionAll: false,
  });
  assert(
    caddyToAdmin.some((h) => h.displayName === "이기흥" && h.role === "admin"),
    "caddy can individually mention admin"
  );
  const fake = filterMentionSuggestions({
    candidates: [
      { userId: 0, displayName: "가짜캐디", team: "1조", role: "caddy" },
      { userId: -4, displayName: "음수", team: "1조", role: "caddy" },
      { userId: 18, displayName: "신정훈", team: "7조", role: "caddy" },
    ],
    query: "",
    canMentionAll: false,
  });
  assert(
    fake.every((h) => h.userId > 0),
    "no User.id is not turned into a fake mention target"
  );
}

section("render + self");
{
  const parts = splitMentionBody("@신정훈 오늘 확인 @전체", {
    mentions: [10],
    mentionAll: true,
    nameByUserId: new Map([[10, "신정훈"]]),
  });
  assert(parts.some((p) => p.kind === "mention" && p.text === "@신정훈"), "highlights @name");
  assert(parts.some((p) => p.kind === "mention" && p.all && p.text === "@전체"), "highlights @전체");
  const textOnly = splitMentionBody("@전체 확인", {
    mentions: [],
    mentionAll: false,
    nameByUserId: new Map(),
  });
  assert(textOnly.every((p) => p.kind === "text"), "unvalidated @전체 stays text");
  assert(
    isSelfMentioned({ myUserId: 10, senderUserId: 11, mentions: [10], mentionAll: false }),
    "other user mentions me"
  );
  assert(
    isSelfMentioned({ myUserId: 10, senderUserId: 11, mentions: [], mentionAll: true }),
    "other user @전체"
  );
  assert(
    !isSelfMentioned({ myUserId: 10, senderUserId: 10, mentions: [], mentionAll: true }),
    "my @전체 has no badge"
  );
  assert(
    !isSelfMentioned({ myUserId: 10, senderUserId: 10, mentions: [10], mentionAll: false }),
    "my explicit @me has no badge"
  );
  assert(!isSelfMentioned({ myUserId: 10, mentions: [11], mentionAll: false }), "other mention not self");
}

section("candidate eligibility / order");
{
  const rows: ChatUserRow[] = [
    { id: 1, username: "admin", role: "ADMIN", caddy: null },
    { id: 2, username: "ghineung", role: "admin", caddy: null },
    { id: 6, username: "이기흥", role: "admin", caddy: null },
    {
      id: 18,
      username: "kakao_a",
      role: "caddy",
      caddy: { name: "신정훈", team: "7조", employmentStatus: "ACTIVE" },
    },
    {
      id: 99,
      username: "kakao_retired",
      role: "caddy",
      caddy: { name: "퇴직자", team: "1조", employmentStatus: "RETIRED" },
    },
    {
      id: 40,
      username: "kakao_leader",
      role: "leader",
      caddy: { name: "조장", team: "3조", employmentStatus: "ACTIVE" },
    },
    { id: 50, username: "nolink", role: "caddy", caddy: null },
  ];
  const hits = listInvitableChatUsers(rows);
  assert(hits.some((h) => h.displayName === "신정훈" && h.role === "caddy"), "active caddy appears");
  assert(hits.some((h) => h.displayName === "조장" && h.role === "leader"), "leader appears");
  assert(hits.some((h) => h.displayName === "이기흥" && h.role === "admin"), "이기흥 kept");
  assert(hits.some((h) => h.displayName === "admin"), "super admin mapping account kept");
  assert(hits.some((h) => h.displayName === "ghineung"), "latin admin kept without blacklist");
  assert(!hits.some((h) => h.displayName === "퇴직자"), "RETIRED excluded");
  assert(!hits.some((h) => h.userId === 50), "unlinked caddy user excluded");
  assert(hits[0]?.role === "caddy" || hits[0]?.role === "leader", "invite/mention list is not admin-first");
  assert(
    hits.findIndex((h) => h.role === "caddy") < hits.findIndex((h) => h.role === "leader") &&
      hits.findIndex((h) => h.role === "leader") < hits.findIndex((h) => h.role === "admin"),
    "invite/mention order is caddy then leader then admin"
  );
  assert(hits.every((h) => Object.keys(h).join(",") === "userId,displayName,team,role,active"), "public keys only");
}

section("worker protocol");
{
  const ok = validateIncomingMessage({
    type: "message",
    clientMessageId: "c-1",
    body: "@신정훈 확인",
    mentions: [1, 1, 2],
    mentionAll: true,
    senderRole: "admin",
  });
  assert(ok.ok && ok.value.body === "@신정훈 확인", "message still validates with mention fields");
  assert(ok.ok && Array.isArray(ok.value.mentions), "raw mentions passed through for server filter");
  const oldClient = validateIncomingMessage({
    type: "message",
    clientMessageId: "c-old",
    body: "phase2 hello",
  });
  assert(oldClient.ok && oldClient.value.mentions === undefined, "old client payload still accepted");
  assert(oldClient.ok && oldClient.value.mentionAll === undefined, "old client has no mentionAll");
  const extra = validateIncomingMessage({
    type: "message",
    clientMessageId: "c-extra",
    body: "hi",
    mentions: [1],
    mentionAll: true,
    senderRole: "admin",
    specialMention: "@전체",
  });
  assert(extra.ok, "unknown extra fields do not reject the message");
  const bad = validateIncomingMessage({ type: "message", clientMessageId: "c-2", body: "" });
  assert(!bad.ok, "empty body still rejected");
}

section("source wiring");
{
  const client = read("src/app/chat/ChatClient.tsx");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  const directory = read("cloudflare/verthill-chat/src/directory.ts");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  const css = read("src/app/globals.css");
  assert(client.includes("senderUserId: line.senderUserId"), "badge uses senderUserId");
  assert(client.includes("mentions: tokens.map"), "composer sends userIds");
  assert(client.includes("mentionAll"), "composer sends mentionAll");
  assert(client.includes("registerAndroidChatOverlayClose"), "mention panel uses overlay back");
  assert(client.includes("setMentionSuppressed(true)"), "back/escape closes suggestions");
  assert(client.includes("멘션 목록 불러오는 중"), "candidate fetch shows loading");
  assert(client.includes("/api/chat/users?scope=all"), "all-room candidates reuse users API");
  assert(client.includes("chatDirectoryMembersUrl"), "custom room uses members");
  assert(!client.includes("setInterval"), "no mention polling");
  assert(worker.includes("mentions_json"), "sqlite mentions_json");
  assert(worker.includes("mention_all"), "sqlite mention_all");
  assert(worker.includes("ALTER TABLE messages ADD COLUMN mentions_json"), "lazy upgrade");
  assert(!/DELETE FROM messages\s*;/.test(worker), "no message wipe");
  assert(worker.includes("DELETE FROM messages WHERE seq = ? AND sent_at < ?"), "retention is batched");
  assert(worker.includes("listDirectoryMemberIds"), "custom member validation");
  assert(worker.includes("resolveMentionAll"), "worker mentionAll from token role");
  assert(worker.includes("memberIds ?? []"), "directory miss fail-closed");
  assert(worker.includes("directorySafePreview"), "directory preview stays safe text");
  assert(!worker.includes("preview: JSON.stringify(mentions)"), "directory preview is not mention json");
  assert((worker.match(/ALTER TABLE messages ADD COLUMN mentions_json/g) || []).length === 1, "one mentions_json alter");
  assert((worker.match(/ALTER TABLE messages ADD COLUMN mention_all/g) || []).length === 1, "one mention_all alter");
  assert(worker.includes("catch {\n      // already present"), "alter duplicate is ignored");
  assert(directory.includes("room_forbidden"), "members ACL 403");
  assert(directory.includes("this.isMember(roomId, claims.userId)"), "members list checks membership");
  assert(worker.includes("persistQueue"), "custom mention persist stays ordered");
  assert(
    /AND m\.seq < \?\s+ORDER BY m\.seq DESC/.test(worker),
    "history pagination SQL stays one statement"
  );
  assert(proto.includes("MAX_MENTIONS = 20"), "protocol max mentions");
  assert(css.includes("vh-chat-mention") && css.includes("vh-chat-suggest"), "mention + suggest css");
  assert(css.includes("vh-chat-mention-self"), "나를 멘션 style");
  assert(css.includes("min(390px, 100%)"), "390 still first");
  const schema = read("prisma/schema.prisma");
  assert(!/model\s+ChatMessage/.test(schema), "no Neon ChatMessage");
}

if (failed > 0) {
  console.error(`\nchat-mention tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-mention tests passed: ${passed}`);
