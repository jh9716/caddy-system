import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(root, "../src/index.ts"), "utf8");
const media = readFileSync(join(root, "../src/chatMedia.ts"), "utf8");
const grant = readFileSync(join(root, "../src/chatMediaGrant.ts"), "utf8");
const wrangler = readFileSync(join(root, "../wrangler.jsonc"), "utf8");

test("chat media routes and grant stay Worker-local", () => {
  assert.match(index, /\/media\/upload/);
  assert.match(index, /handleChatMediaRequest/);
  assert.match(index, /CHAT_MEDIA\?:/);
  assert.match(index, /CHAT_MEDIA_SECRET\?:/);
  assert.match(index, /x-chat-media-grant/);
  assert.match(media, /CHAT_MEDIA_UPLOAD_PATH = "\/media\/upload"/);
  assert.match(media, /CHAT_MEDIA_INSPECT_PATH = "\/internal\/media\/inspect"/);
  assert.match(media, /CHAT_MEDIA_OBJECT_PATH = "\/internal\/media\/object"/);
  assert.match(media, /verifyChatMediaPutGrant/);
  assert.match(media, /verifyInternalRequest/);
  assert.match(media, /deriveChatMediaR2Key/);
  assert.match(media, /inspectChatMediaMagic/);
  assert.match(media, /etagDoesNotMatch: "\*"/);
  assert.match(media, /readBoundedBody/);
  assert.match(media, /upload_conflict/);
  assert.match(media, /customMetadata/);
  assert.doesNotMatch(media, /await request\.arrayBuffer\(\)/);
  assert.doesNotMatch(media, /issueSignedToken|presignUrl|@vercel\/blob/);
  assert.doesNotMatch(grant, /BLOB_|R2_SECRET|accessKey|clientSigningToken/i);
  const grantType = grant.slice(
    grant.indexOf("export type ChatMediaPutGrant"),
    grant.indexOf("export type ChatMediaGrantSecretEnv")
  );
  assert.doesNotMatch(grantType, /storageKey|uploadUrl|secret/);
  assert.match(grant, /op = "chat_media_put"|CHAT_MEDIA_PUT_OP = "chat_media_put"/);
  assert.match(grant, /CHAT_MEDIA_SECRET/);
  assert.match(grant, /CHAT_MEDIA_R2_KEY_PREFIX = "chat\/"/);
  assert.match(grant, /CHAT_PHOTO_R2_DB_PREFIX = "r2\/"/);
  assert.match(grant, /\$\{input\.roomId\}\/\$\{input\.attachmentId\}/);
  assert.doesNotMatch(index, /vercel|neon|prisma|vh_session|FCM|D1|KV/i);
});

test("production wrangler does not bind CHAT_MEDIA in this PR", () => {
  assert.match(wrangler, /CHAT_MEDIA_SECRET/);
  assert.match(wrangler, /verthill-chat-media/);
  assert.doesNotMatch(wrangler, /"r2_buckets"\s*:/);
});
