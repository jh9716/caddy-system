/**
 * Production chat-speed slice must not import Preview-only or PR #349-only paths.
 */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const repo = join(root, "../..");

function read(rel) {
  return readFileSync(join(repo, rel), "utf8");
}

test("slice files do not pull Preview-only or roster/CSV stacks", () => {
  const index = readFileSync(join(root, "src/index.ts"), "utf8");
  const sessionCheck = readFileSync(join(root, "src/sessionCheck.ts"), "utf8");
  const client = read(join("src/app/chat/ChatClient.tsx"));
  const reuse = read(join("src/lib/chatWsReuse.ts"));

  assert.equal(existsSync(join(root, "src/nextApp.ts")), false);
  assert.doesNotMatch(index, /PREVIEW_APP_BYPASS|chatPerf|CHAT_PERF|previewPerf|isPreviewChatPerf/);
  assert.doesNotMatch(sessionCheck, /nextApp|PREVIEW_APP_HOST|PREVIEW_APP_BYPASS/);
  assert.doesNotMatch(client, /chatPerfDiag|ChatPerfPanel|CHAT_PERF_PING|PREVIEW_APP_BYPASS/);
  assert.doesNotMatch(reuse, /CHAT_WS_REUSE_STORAGE_KEY|chatReuse=/);
  assert.match(reuse, /PRODUCTION_CHAT_WS_REUSE_ENABLED(?:: boolean)? = false/);
  assert.doesNotMatch(index, /roster|csv|employmentStatus/i);
});
