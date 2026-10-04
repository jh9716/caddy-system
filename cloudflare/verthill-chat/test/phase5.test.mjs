import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(root, "../src/index.ts"), "utf8");
const proto = readFileSync(join(root, "../src/protocol.ts"), "utf8");
const directory = readFileSync(join(root, "../src/directory.ts"), "utf8");

test("phase5 dm worker wiring", () => {
  assert.match(proto, /DM_ROOM_ID_RE/);
  assert.match(proto, /canonicalDmRoomId/);
  assert.match(proto, /isDmRoomId/);
  assert.match(index, /isDm: isDmRoomId\(room\)/);
  assert.match(index, /resolveMentionAll\(value\.mentionAll, senderRole, attach\.roomId\)/);
  assert.match(directory, /handleInternalCreateDm/);
  assert.match(directory, /type === "DM"/);
  assert.match(directory, /dm_pair_mismatch/);
  assert.doesNotMatch(index, /FCM|prisma/i);
  assert.doesNotMatch(directory, /DROP TABLE/);
});
