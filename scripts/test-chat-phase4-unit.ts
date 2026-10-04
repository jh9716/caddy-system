/**
 * Chat Phase 4 — reconnect / sync / reply / delete / retention / layout.
 * 실행: npm run test:chat-phase4-unit
 */
import {
  DELETE_FOR_EVERYONE_WINDOW_MS,
  MESSAGE_RETENTION_DAYS,
  canAdminDelete,
  canDeleteForEveryone,
  canMentionAll,
  directorySafePreview,
  replyTargetFromRow,
  resolveMentionAll,
  validateIncomingDelete,
  validateIncomingHide,
  validateIncomingMessage,
  validateIncomingSync,
} from "../cloudflare/verthill-chat/src/protocol";
import {
  applyDeletedLine,
  applyHiddenSeq,
  chatActionItems,
  displayTombstone,
  estimateChatStorageBytes,
  formatStorageRange,
  lastKnownSeq,
  mergeChatLines,
  DELETE_FOR_EVERYONE_WINDOW_MS as CLIENT_WINDOW,
  MESSAGE_RETENTION_DAYS as CLIENT_RETENTION,
} from "../src/lib/chatPhase4";
import {
  chatReconnectStatus,
  nextReconnectDelay,
  RECONNECT_DELAYS_MS,
  shouldIgnoreStaleSocket,
  shouldRefreshTokenOnClose,
} from "../src/lib/chatReconnect";
import { filterMentionSuggestions } from "../src/lib/chatMentions";
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

section("caddy individual mention / mentionAll spoof");
{
  const hits = filterMentionSuggestions({
    candidates: [
      { userId: 6, displayName: "이기흥", team: "-", role: "admin" },
      { userId: 40, displayName: "조장", team: "3조", role: "leader" },
      { userId: 18, displayName: "신정훈", team: "7조", role: "caddy" },
    ],
    query: "이기흥",
    canMentionAll: false,
  });
  assert(hits.some((h) => h.displayName === "이기흥"), "caddy → admin mention");
  assert(
    filterMentionSuggestions({
      candidates: [{ userId: 40, displayName: "조장", team: "3조", role: "leader" }],
      query: "조",
      canMentionAll: false,
    }).some((h) => h.role === "leader"),
    "caddy → leader mention"
  );
  assert(
    filterMentionSuggestions({
      candidates: [{ userId: 27, displayName: "한상준", team: "7조", role: "caddy" }],
      query: "한",
      canMentionAll: false,
    }).some((h) => h.role === "caddy"),
    "caddy → caddy mention"
  );
  assert(
    filterMentionSuggestions({
      candidates: [{ userId: 18, displayName: "신정훈", team: "7조", role: "caddy" }],
      query: "신",
      canMentionAll: true,
    }).some((h) => h.role === "caddy"),
    "admin → caddy mention"
  );
  assert(!canMentionAll("caddy"), "caddy cannot @전체");
  assert(resolveMentionAll(true, "caddy") === false, "caddy mentionAll:true spoof → false");
}

section("reconnect");
{
  assert(nextReconnectDelay(0, () => 0) === 500, "backoff 0.5s");
  assert(nextReconnectDelay(1, () => 0) === 1000, "backoff 1s");
  assert(nextReconnectDelay(2, () => 0) === 2000, "backoff 2s");
  assert(nextReconnectDelay(3, () => 0) === 4000, "backoff 4s");
  assert(nextReconnectDelay(4, () => 0) === 8000, "backoff 8s");
  assert(nextReconnectDelay(9, () => 0) === 15000, "backoff max 15s");
  assert(RECONNECT_DELAYS_MS[0] === 500, "first delay 500");
  assert(shouldRefreshTokenOnClose(4008), "4008 refreshes token");
  assert(!shouldRefreshTokenOnClose(1000), "normal close is not token expiry");
  assert(shouldIgnoreStaleSocket(2, 1), "stale socket ignored");
  assert(!shouldIgnoreStaleSocket(3, 3), "current socket kept");
  assert(chatReconnectStatus({ connected: true, failingSinceMs: 1 }) === "ok", "connected is ok");
  assert(
    chatReconnectStatus({ connected: false, failingSinceMs: Date.now(), nowMs: Date.now() }) ===
      "reconnecting",
    "brief drop is reconnecting"
  );
  assert(
    chatReconnectStatus({
      connected: false,
      failingSinceMs: 1,
      nowMs: 1 + 16_000,
    }) === "failed",
    "long drop shows fallback"
  );
}

section("seq sync merge");
{
  const sizes = [0, 1, 30, 100, 500];
  for (const n of sizes) {
    const prev = Array.from({ length: Math.min(n, 20) }, (_, i) => ({
      clientMessageId: `old-${i + 1}`,
      seq: i + 1,
    }));
    const incoming = Array.from({ length: n }, (_, i) => ({
      clientMessageId: `n-${i + 1}`,
      seq: i + 1,
    }));
    const merged = mergeChatLines(prev, incoming);
    const seqs = merged.map((m) => m.seq);
    assert(merged.length === n || (n === 0 && merged.length === prev.length), `merge size ${n}`);
    assert(new Set(seqs).size === seqs.length, `no duplicate seq ${n}`);
    assert(
      seqs.every((seq, i) => i === 0 || (seq || 0) >= (seqs[i - 1] || 0)),
      `seq ASC ${n}`
    );
  }
  assert(lastKnownSeq([{ seq: 3 }, { seq: 9 }, { clientMessageId: "x" }]) === 9, "lastKnownSeq");
  const hidden = applyHiddenSeq(
    [
      { seq: 1, clientMessageId: "a" },
      { seq: 2, clientMessageId: "b" },
    ],
    2
  );
  assert(hidden.length === 1 && hidden[0]!.seq === 1, "hide is per-user local apply");
}

section("delete / tombstone / reply");
{
  assert(CLIENT_WINDOW === DELETE_FOR_EVERYONE_WINDOW_MS, "window constant shared");
  assert(CLIENT_WINDOW === 10 * 60 * 1000, "10 minute everyone window");
  assert(CLIENT_RETENTION === MESSAGE_RETENTION_DAYS && CLIENT_RETENTION === 180, "180 day retention");
  assert(
    canDeleteForEveryone({
      actorUserId: 8,
      senderUserId: 8,
      sentAtMs: Date.now() - 60_000,
    }),
    "sender can delete within window"
  );
  assert(
    !canDeleteForEveryone({
      actorUserId: 8,
      senderUserId: 8,
      sentAtMs: Date.now() - 11 * 60 * 1000,
    }),
    "window expired rejected"
  );
  assert(
    !canDeleteForEveryone({
      actorUserId: 9,
      senderUserId: 8,
      sentAtMs: Date.now(),
    }),
    "other user cannot everyone-delete"
  );
  assert(canAdminDelete("admin"), "admin can force delete");
  assert(!canAdminDelete("leader"), "leader cannot admin-delete");
  assert(!canAdminDelete("caddy"), "caddy cannot admin-delete");
  assert(displayTombstone("everyone") === "메시지가 삭제되었습니다.", "everyone tombstone");
  assert(displayTombstone("admin") === "관리자가 메시지를 삭제했습니다.", "admin tombstone");
  assert(
    directorySafePreview({ body: "비밀", deletionType: "everyone" }) === "메시지가 삭제되었습니다.",
    "directory preview does not leak body"
  );
  const expired = replyTargetFromRow({
    replyToSeq: 12,
    targetSeq: null,
  });
  assert(expired?.state === "expired" && expired.preview === "보관기간이 지난 메시지입니다.", "purged reply");
  const gone = replyTargetFromRow({
    replyToSeq: 12,
    targetSeq: 12,
    targetSender: "신정훈",
    targetBody: "원문",
    targetDeletionType: "everyone",
  });
  assert(gone?.state === "deleted" && gone.preview === "삭제된 메시지입니다.", "deleted reply");
  const items = chatActionItems({
    myUserId: 1,
    myRole: "admin",
    senderUserId: 2,
    sentAt: new Date().toISOString(),
  });
  assert(items.includes("reply") && items.includes("hide") && items.includes("delete-admin"), "admin menu");
  assert(!items.includes("delete-everyone"), "admin does not everyone-delete others");
  const mine = chatActionItems({
    myUserId: 2,
    myRole: "caddy",
    senderUserId: 2,
    sentAt: new Date().toISOString(),
  });
  assert(mine.includes("delete-everyone") && !mine.includes("delete-admin"), "own everyone delete");
  const after = applyDeletedLine(
    [
      {
        clientMessageId: "a",
        senderUserId: 2,
        sender: "신정훈",
        senderRole: "caddy",
        body: "비밀",
        sentAt: "t",
        seq: 5,
        mentions: [1],
        mentionAll: false,
      },
    ],
    { seq: 5, deletionType: "admin", deletedAt: "now" }
  );
  assert(after[0]!.body === "" && after[0]!.deletionType === "admin", "tombstone clears body");
}

section("protocol validators");
{
  const msg = validateIncomingMessage({
    type: "message",
    clientMessageId: "c-1",
    body: "hi",
    replyToSeq: 3,
    mentionAll: true,
  });
  assert(msg.ok && msg.value.replyToSeq === 3, "replyToSeq accepted");
  const spoof = validateIncomingMessage({
    type: "message",
    clientMessageId: "c-2",
    body: "x",
    senderRole: "admin",
    userId: 99,
    deletedBy: 1,
  });
  assert(spoof.ok, "client role spoof fields ignored by validator");
  const sync = validateIncomingSync({ type: "sync", afterSeq: 10, limit: 500 });
  assert(sync.ok && sync.limit === 100, "sync limit capped 100");
  const hide = validateIncomingHide({ type: "hide", seq: 4 });
  assert(hide.ok && hide.seq === 4, "hide seq");
  const del = validateIncomingDelete({ type: "delete", seq: 4, mode: "admin" });
  assert(del.ok && del.mode === "admin", "delete admin mode");
  assert(!validateIncomingDelete({ type: "delete", seq: 4, mode: "me" }).ok, "me is not tombstone mode");
}

section("storage estimate");
{
  const k1 = estimateChatStorageBytes({ msgsPerDay: 1000 });
  const k5 = estimateChatStorageBytes({ msgsPerDay: 5000 });
  const k20 = estimateChatStorageBytes({ msgsPerDay: 20000 });
  assert(k1.messageCount === 180_000, "1k/day * 180");
  assert(k5.messageCount === 900_000, "5k/day * 180");
  assert(k20.messageCount === 3_600_000, "20k/day * 180");
  assert(k1.totalBytes < k5.totalBytes && k5.totalBytes < k20.totalBytes, "size scales");
  console.log(
    "  · 180d estimate",
    formatStorageRange(k1.totalBytes),
    "/",
    formatStorageRange(k5.totalBytes),
    "/",
    formatStorageRange(k20.totalBytes)
  );
}

section("source wiring");
{
  const client = read("src/app/chat/ChatClient.tsx");
  const css = read("src/app/globals.css");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  const dir = read("cloudflare/verthill-chat/src/directory.ts");
  const back = read("src/lib/androidSystemBack.ts");
  assert(client.includes("type: \"sync\""), "client sends sync");
  assert(client.includes("nextReconnectDelay"), "auto reconnect backoff");
  assert(client.includes("visibilitychange"), "visible reconnect");
  assert(client.includes("addEventListener(\"online\""), "online reconnect");
  assert(client.includes("visualViewport"), "keyboard visualViewport");
  assert(client.includes("다시 시도"), "manual fallback only after long fail");
  assert(!client.includes(">다시 연결<"), "no always-on reconnect button");
  assert(client.includes("나에게서만 삭제"), "hide action");
  assert(client.includes("모두에게서 삭제"), "everyone delete action");
  assert(client.includes("관리자 삭제"), "admin delete action");
  assert(client.includes("답장"), "reply action");
  assert(client.includes("vh-chat-reply-draft"), "reply composer preview");
  assert(client.includes("registerAndroidChatOverlayClose(() => setActionLine(null))"), "back closes menu first");
  assert(css.includes("--vh-keyboard-inset"), "keyboard inset var");
  assert(css.includes(".vh-work:has(.vh-chat)"), "fixed chat viewport");
  assert(css.includes(".vh-chat-log"), "message area scrolls");
  assert(css.includes("text-decoration: underline"), "mention underline");
  assert(proto.includes("DELETE_FOR_EVERYONE_WINDOW_MS = 10 * 60 * 1000"), "10m window");
  assert(proto.includes("MESSAGE_RETENTION_DAYS = 180"), "180 days");
  assert(worker.includes("hidden_messages"), "per-user hide table");
  assert(worker.includes("reply_to_seq"), "reply column");
  assert(worker.includes("deletion_type"), "tombstone column");
  assert(worker.includes("async alarm()"), "DO alarm retention");
  assert(worker.includes("purgeExpiredMessages"), "batched purge");
  assert(!worker.includes("FCM"), "no FCM push");
  assert(!dir.includes("FCM"), "directory has no FCM");
  assert(back.includes("close-chat-overlay"), "overlay still before leave-room");
  const schema = read("prisma/schema.prisma");
  assert(!/model\s+ChatMessage/.test(schema), "no Neon ChatMessage");
  const migrations = fs.readdirSync("prisma/migrations");
  assert(!migrations.some((name) => /chat/i.test(name)), "Prisma chat migration = 0");
  const wrangler = read("cloudflare/verthill-chat/wrangler.jsonc");
  assert(!wrangler.includes("v3"), "no new wrangler DO class");
  assert(!client.includes("localStorage"), "hide is not localStorage-only");
}

if (failed > 0) {
  console.error(`\nchat-phase4 tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-phase4 tests passed: ${passed}`);
