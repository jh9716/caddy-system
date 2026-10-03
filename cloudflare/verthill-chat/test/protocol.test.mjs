import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(root, "../src/protocol.ts"), "utf8");

test("protocol limits and room regex exist", () => {
  assert.match(src, /BODY_MAX = 2000/);
  assert.match(src, /HISTORY_LIMIT = 30/);
  assert.match(src, /ROOM_NAME_RE/);
  assert.match(src, /clientMessageId/);
});

test("worker stays isolated from Next/Neon/Vercel", () => {
  const index = readFileSync(join(root, "../src/index.ts"), "utf8");
  assert.doesNotMatch(index, /vercel|neon|prisma|vh_session|FCM|D1|R2|KV/i);
  assert.match(index, /DurableObject/);
  assert.match(index, /CHAT_ROOM/);
  assert.match(index, /acceptWebSocket/);
});
