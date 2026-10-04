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
  assert(isSelfMentioned({ myUserId: 10, mentions: [10], mentionAll: false }), "self mentioned");
  assert(isSelfMentioned({ myUserId: 10, mentions: [], mentionAll: true }), "mentionAll counts as self");
  assert(!isSelfMentioned({ myUserId: 10, mentions: [11], mentionAll: false }), "other mention not self");
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
  const bad = validateIncomingMessage({ type: "message", clientMessageId: "c-2", body: "" });
  assert(!bad.ok, "empty body still rejected");
}

section("source wiring");
{
  const client = read("src/app/chat/ChatClient.tsx");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  const css = read("src/app/globals.css");
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
  assert(!worker.includes("DELETE FROM messages"), "no message wipe");
  assert(worker.includes("listDirectoryMemberIds"), "custom member validation");
  assert(worker.includes("resolveMentionAll"), "worker mentionAll from token role");
  assert(worker.includes("persistQueue"), "custom mention persist stays ordered");
  assert(
    /WHERE seq < \?\s+ORDER BY seq DESC/.test(worker),
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
