import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, "../src/protocol.ts"), "utf8");

test("protocol limits and team rooms exist", () => {
  assert.match(src, /BODY_MAX = 2000/);
  assert.match(src, /HISTORY_LIMIT = 30/);
  assert.match(src, /MAX_CONNECTIONS = 200/);
  assert.match(src, /MAX_CONNECTIONS_ALL = 800/);
  assert.match(src, /HISTORY_PAGE_MAX = 50/);
  assert.match(src, /MESSAGE_MAX = 4096/);
  assert.match(src, /team-1/);
  assert.match(src, /team-12/);
  assert.match(src, /ALL_ROOM_ID = "all"/);
  assert.match(src, /MAX_MENTIONS = 20/);
  assert.match(src, /canMentionAll/);
  assert.match(src, /resolveMentionAll/);
  assert.doesNotMatch(src, /poc-room/);
});

test("worker stays isolated from Next/Neon/Vercel", () => {
  const index = readFileSync(join(root, "../src/index.ts"), "utf8");
  const directory = readFileSync(join(root, "../src/directory.ts"), "utf8");
  assert.doesNotMatch(index, /vercel|neon|prisma|vh_session|FCM|D1|R2|KV/i);
  assert.doesNotMatch(directory, /vercel|neon|prisma|vh_session|FCM|D1|R2|KV/i);
  assert.match(index, /DurableObject/);
  assert.match(index, /CHAT_ROOM/);
  assert.match(index, /CHAT_DIRECTORY/);
  assert.match(index, /acceptWebSocket/);
  assert.match(index, /verifyChatToken/);
  assert.match(index, /room_forbidden/);
  assert.match(index, /sender_role/);
  assert.match(index, /mentions_json/);
  assert.match(index, /mention_all/);
  assert.doesNotMatch(index, /trimHistory|DELETE FROM messages/);
  assert.match(index, /validateIncomingHistory/);
  assert.match(index, /server_only/);
  assert.match(index, /CHAT_INTERNAL_SECRET/);
  assert.match(index, /new Request\(request\.url, request\)/);
  assert.match(index, /x-chat-claims/);
  assert.doesNotMatch(
    index,
    /new Request\(url\.toString\(\),\s*\{[\s\S]*method: request\.method/,
    "directory WS must not rebuild a non-upgrade Request"
  );
});
