import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const require = createRequire(import.meta.url);

const root = dirname(fileURLToPath(import.meta.url));
const index = readFileSync(join(root, "../src/index.ts"), "utf8");
const media = readFileSync(join(root, "../src/chatMedia.ts"), "utf8");
const grant = readFileSync(join(root, "../src/chatMediaGrant.ts"), "utf8");
const wrangler = readFileSync(join(root, "../wrangler.jsonc"), "utf8");
const uploadFn = media.slice(
  media.indexOf("export async function handleChatMediaUpload"),
  media.indexOf("export async function handleChatMediaInspect")
);

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
  assert.match(media, /signChatMediaUploadReceipt/);
  assert.match(media, /chat_media_upload_failed/);
  assert.match(media, /r2PutStarted/);
  assert.doesNotMatch(media, /await request\.arrayBuffer\(\)/);
  assert.match(uploadFn, /readBoundedBody/);
  assert.match(uploadFn, /sha256Hex/);
  assert.match(uploadFn, /sha256: digest/);
  assert.doesNotMatch(uploadFn, /bounded\.stream/);
  assert.match(uploadFn, /bounded\.bytes/);
  assert.match(uploadFn, /upload_failed/);
  assert.doesNotMatch(media, /issueSignedToken|presignUrl|@vercel\/blob/);
  assert.doesNotMatch(grant, /BLOB_|R2_SECRET|accessKey|clientSigningToken/i);
  const grantType = grant.slice(
    grant.indexOf("export type ChatMediaPutGrant"),
    grant.indexOf("export type ChatMediaGrantSecretEnv")
  );
  assert.doesNotMatch(grantType, /storageKey|uploadUrl|secret/);
  assert.match(grant, /op = "chat_media_put"|CHAT_MEDIA_PUT_OP = "chat_media_put"/);
  assert.match(grant, /CHAT_MEDIA_UPLOADED_OP = "chat_media_uploaded"/);
  assert.match(grant, /CHAT_MEDIA_SECRET/);
  assert.match(grant, /CHAT_MEDIA_R2_KEY_PREFIX = "chat\/"/);
  assert.match(grant, /CHAT_PHOTO_R2_DB_PREFIX = "r2\/"/);
  assert.match(grant, /\$\{input\.roomId\}\/\$\{input\.attachmentId\}/);
  assert.doesNotMatch(index, /vercel|neon|prisma|vh_session|FCM|D1|KV/i);
});

test("production wrangler binds CHAT_MEDIA to verthill-chat-media", () => {
  assert.match(wrangler, /CHAT_MEDIA_SECRET/);
  assert.match(wrangler, /"r2_buckets"\s*:/);
  assert.match(wrangler, /"binding":\s*"CHAT_MEDIA"/);
  assert.match(wrangler, /"bucket_name":\s*"verthill-chat-media"/);
  assert.doesNotMatch(wrangler, /"CHAT_MEDIA_SECRET"\s*:/);
});

test("production wrangler keep_vars is top-level true; name/R2/DO/migrations unchanged", () => {
  assert.match(wrangler, /"keep_vars"\s*:\s*true/);
  const previewBlock = wrangler.slice(wrangler.indexOf('"env"'));
  assert.doesNotMatch(previewBlock, /"keep_vars"/, "keep_vars is not inside env.preview");

  const { unstable_readConfig } = require("wrangler");
  const configPath = join(root, "../wrangler.jsonc");
  const prod = unstable_readConfig({ config: configPath });
  const preview = unstable_readConfig({ config: configPath, env: "preview" });

  assert.equal(prod.keep_vars, true, "parsed production keep_vars");
  assert.equal(prod.name, "verthill-chat");
  assert.equal(preview.name, "verthill-chat-preview");
  assert.equal(preview.keep_vars, true, "top-level keep_vars applies to --env preview parse");
  assert.equal(preview.vars?.CHAT_TOKEN_AUDIENCE, "preview");

  const prodR2 = (prod.r2_buckets || []).map((b) => b.bucket_name);
  const prevR2 = (preview.r2_buckets || []).map((b) => b.bucket_name);
  assert.deepEqual(prodR2, ["verthill-chat-media"]);
  assert.deepEqual(prevR2, ["verthill-chat-media-preview"]);

  const prodDo = (prod.durable_objects?.bindings || []).map((b) => `${b.name}:${b.class_name}`);
  const prevDo = (preview.durable_objects?.bindings || []).map((b) => `${b.name}:${b.class_name}`);
  assert.deepEqual(prodDo, ["CHAT_ROOM:ChatRoom", "CHAT_DIRECTORY:ChatDirectory"]);
  assert.deepEqual(prevDo, ["CHAT_ROOM:ChatRoom", "CHAT_DIRECTORY:ChatDirectory"]);
  assert.equal((preview.durable_objects?.bindings || []).some((b) => b.script_name), false);

  const tags = (prod.migrations || []).map((m) => m.tag);
  assert.deepEqual(tags, ["v1", "v2"]);
  const previewTags = (preview.migrations || []).map((m) => m.tag);
  assert.deepEqual(previewTags, ["v1", "v2"]);
});
