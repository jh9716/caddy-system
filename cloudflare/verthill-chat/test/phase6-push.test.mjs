import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = readFileSync(new URL("../src/index.ts", import.meta.url), "utf8");

describe("phase6 chat push dispatch", () => {
  it("dispatches after persist, never on delete", () => {
    assert.match(src, /queueChatPushDispatch/);
    assert.match(src, /CHAT_PUSH_DISPATCH_URL/);
    assert.match(src, /\/api\/chat\/push-dispatch/);
    assert.match(src, /if \(!url \|\| message\.deletionType\) return/);
    assert.doesNotMatch(src, /queueChatPushDispatch\(attach\.roomId, tombstone/);
    assert.match(src, /ctx\.waitUntil\(this\.sendChatPushDispatch/);
    assert.match(src, /replyToSenderUserId/);
    assert.doesNotMatch(src, /queueChatPushDispatch\(attach\.roomId, event\)/);
  });
});
