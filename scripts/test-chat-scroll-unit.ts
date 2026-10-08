/**
 * Chat entry scroll: unread snapshot, target priority, pagination, pin.
 * 실행: npm run test:chat-scroll-unit
 */
import {
  CHAT_UNREAD_SPLIT_LABEL,
  applyChatEntryScroll,
  firstLoadedSeqAtOrAfter,
  firstUnreadSeqFromSummary,
  parseChatTargetSeq,
  parseChatTargetSeqFromRoomUrl,
  resolveChatEntryTarget,
  shouldAutoLoadOlderOnScroll,
  shouldFollowIncomingMessage,
  shouldReapplyPinnedEntryScroll,
  shouldRequestOlderForTarget,
  shouldShowUnreadSplit,
  snapshotChatEntry,
} from "../src/lib/chatScroll";

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

console.log("\n== first unread formula ==");
assert(firstUnreadSeqFromSummary(40, 0) == null, "unread=0 → no first unread");
assert(firstUnreadSeqFromSummary(40, 1) === 40, "unread=1 → that message");
assert(firstUnreadSeqFromSummary(40, 5) === 36, "unread several → first unread");
assert(firstUnreadSeqFromSummary(10, 10) === 1, "all unread starts at seq 1");
assert(firstUnreadSeqFromSummary(0, 3) == null, "empty room has no first unread");

console.log("\n== entry target priority ==");
{
  const none = snapshotChatEntry({ unread: 0, lastMessageSeq: 40 });
  assert(resolveChatEntryTarget(none).kind === "bottom", "unread=0 → bottom");
  const one = snapshotChatEntry({ unread: 1, lastMessageSeq: 40 });
  assert(resolveChatEntryTarget(one).kind === "unread" && one.firstUnreadSeq === 40, "unread=1 target");
  const many = snapshotChatEntry({ unread: 7, lastMessageSeq: 40 });
  assert(
    resolveChatEntryTarget(many).kind === "unread" && many.firstUnreadSeq === 34,
    "unread several → first unread"
  );
  const explicit = snapshotChatEntry({ unread: 7, lastMessageSeq: 40, explicitSeq: 12 });
  const target = resolveChatEntryTarget(explicit);
  assert(target.kind === "explicit" && target.seq === 12, "explicit target + unread → explicit first");
  assert(parseChatTargetSeq("12") === 12 && parseChatTargetSeq("nope") == null, "URL seq parse");
  assert(
    parseChatTargetSeqFromRoomUrl("all", "?room=all&seq=12") === 12,
    "deep-link seq applies to that room"
  );
  assert(
    parseChatTargetSeqFromRoomUrl("all", "?room=room_0123456789abcdef&seq=12") == null,
    "seq for another room is ignored"
  );
  assert(parseChatTargetSeqFromRoomUrl("all", "?seq=12") == null, "seq without room is ignored");
}

console.log("\n== pagination seek ==");
{
  assert(
    shouldRequestOlderForTarget({
      targetSeq: 10,
      oldestLoadedSeq: 71,
      hasMore: true,
      pages: 0,
    }),
    "first unread outside initial history → load older"
  );
  assert(
    !shouldRequestOlderForTarget({
      targetSeq: 80,
      oldestLoadedSeq: 71,
      hasMore: true,
      pages: 0,
    }),
    "target already in loaded window → no extra page"
  );
  assert(
    !shouldRequestOlderForTarget({
      targetSeq: 10,
      oldestLoadedSeq: 5,
      hasMore: true,
      pages: 0,
    }),
    "oldest already at/before target → stop"
  );
  assert(
    !shouldRequestOlderForTarget({
      targetSeq: 10,
      oldestLoadedSeq: 71,
      hasMore: false,
      pages: 0,
    }),
    "no more history → stop"
  );
  assert(
    !shouldRequestOlderForTarget({
      targetSeq: 10,
      oldestLoadedSeq: 71,
      hasMore: true,
      pages: 20,
    }),
    "bounded seek pages"
  );
  const lines = [{ seq: 71 }, { seq: 72 }, { seq: 80 }];
  assert(firstLoadedSeqAtOrAfter(lines, 10) === 71, "gap/hidden → next loaded seq");
  assert(firstLoadedSeqAtOrAfter(lines, 72) === 72, "exact loaded seq");
  assert(firstLoadedSeqAtOrAfter(lines, 90) == null, "target newer than loaded → keep seeking or fall back");
}

console.log("\n== divider / follow / pin ==");
{
  assert(CHAT_UNREAD_SPLIT_LABEL === "여기부터 읽지 않은 메시지", "divider copy");
  assert(
    shouldShowUnreadSplit({ firstUnreadSeq: 36, lineSeq: 36, prevSeq: 35 }),
    "divider before first unread"
  );
  assert(
    !shouldShowUnreadSplit({ firstUnreadSeq: 36, lineSeq: 37, prevSeq: 36 }),
    "no second divider"
  );
  assert(!shouldShowUnreadSplit({ firstUnreadSeq: null, lineSeq: 36 }), "no divider when fully read");
  assert(shouldFollowIncomingMessage({ stuckToBottom: true }), "bottom user keeps auto-follow");
  assert(
    !shouldFollowIncomingMessage({ stuckToBottom: false }),
    "reading history is not forced to bottom"
  );
  assert(
    shouldReapplyPinnedEntryScroll({ userMoved: false, pin: { kind: "seq", seq: 36 } }),
    "image layout reapplies the same pin"
  );
  assert(
    !shouldReapplyPinnedEntryScroll({ userMoved: true, pin: { kind: "seq", seq: 36 } }),
    "after user scroll, layout does not jump"
  );
  assert(
    !shouldAutoLoadOlderOnScroll({ scrollTop: 0, nearBottom: true, seeking: false }),
    "short log at bottom does not auto-page older"
  );
  assert(
    !shouldAutoLoadOlderOnScroll({ scrollTop: 10, nearBottom: false, seeking: true }),
    "entry seek does not steal pagination"
  );
  assert(
    shouldAutoLoadOlderOnScroll({ scrollTop: 10, nearBottom: false, seeking: false }),
    "user at top still pages older"
  );
}

console.log("\n== apply scroll ==");
{
  const root = {
    scrollTop: 0,
    scrollHeight: 800,
    getBoundingClientRect: () => ({ top: 0 }),
    querySelector: () => null,
  } as unknown as HTMLElement;
  assert(applyChatEntryScroll(root, { kind: "bottom", seq: null }) && root.scrollTop === 800, "bottom pin");
}

if (failed > 0) {
  console.error(`\nFAIL ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
