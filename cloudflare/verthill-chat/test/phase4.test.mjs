import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(root, "../src/index.ts"), "utf8");
const proto = readFileSync(join(root, "../src/protocol.ts"), "utf8");

test("phase4 worker wiring", () => {
  assert.match(index, /hidden_messages/);
  assert.match(index, /reply_to_seq/);
  assert.match(index, /validateIncomingSync/);
  assert.match(index, /validateIncomingHide/);
  assert.match(index, /validateIncomingDelete/);
  assert.match(index, /async alarm\(\)/);
  assert.match(index, /senderRoleFromClaims\(attach\.claims\.role\)/);
  assert.match(proto, /DELETE_FOR_EVERYONE_WINDOW_MS = 10 \* 60 \* 1000/);
  assert.match(proto, /MESSAGE_RETENTION_DAYS = 180/);
  assert.doesNotMatch(index, /FCM|prisma/i);
  assert.doesNotMatch(index, /DELETE FROM messages\s*;/);
  assert.match(index, /DELETE FROM messages WHERE seq = \? AND sent_at < \?/);
});
