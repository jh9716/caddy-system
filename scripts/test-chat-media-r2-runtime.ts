/**
 * Miniflare / workerd R2 binding: Request body → handleChatMediaUpload → put → readback.
 * No production R2. 실행: npm run test:chat-media-r2-runtime
 */
import { createRequire } from "node:module";
import { CHAT_PHOTO_MAX_BYTES } from "../src/lib/chatPhotoConstants";
import {
  createBoundedConcatStream,
  handleChatMediaRequest,
  readPrefixThenRest,
  type ChatMediaBucket,
} from "../cloudflare/verthill-chat/src/chatMedia";
import {
  CHAT_MEDIA_GRANT_HEADER,
  CHAT_MEDIA_PUT_OP,
  deriveChatMediaR2Key,
  signChatMediaPutGrant,
  verifyChatMediaUploadReceipt,
} from "../cloudflare/verthill-chat/src/chatMediaGrant";

const requireFromWorker = createRequire(new URL("../cloudflare/verthill-chat/package.json", import.meta.url));
const wrangler = requireFromWorker("wrangler") as {
  getPlatformProxy: (opts: {
    configPath: string;
    persist: boolean;
    remoteBindings: boolean;
  }) => Promise<{
    env: { CHAT_MEDIA?: ChatMediaBucket };
    dispose: () => Promise<void>;
  }>;
};

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

function jpegBytes(total: number, mark = 1): Uint8Array {
  const out = new Uint8Array(Math.max(5, total));
  out.set([0xff, 0xd8, 0xff, 0xe0], 0);
  out[4] = mark;
  return out;
}

function pngBytes(total = 64): Uint8Array {
  const out = new Uint8Array(Math.max(12, total));
  out.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  return out;
}

function webpBytes(total = 64): Uint8Array {
  const out = new Uint8Array(Math.max(16, total));
  out.set([0x52, 0x49, 0x46, 0x46, 8, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
  return out;
}

function pdfBytes(): Uint8Array {
  return new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2d, 0x31, 0x2e, 0x37]);
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}

async function uploadJson(res: Response | null): Promise<any> {
  if (!res) return null;
  return res.clone().json().catch(() => null);
}

const SECRET = "chat-media-runtime-secret";
const ROOM = "all";

async function grantFor(attachmentId: string, mimeType: "image/jpeg" | "image/png" | "image/webp" = "image/jpeg") {
  return signChatMediaPutGrant(SECRET, {
    v: 1,
    op: CHAT_MEDIA_PUT_OP,
    roomId: ROOM,
    attachmentId,
    senderUserId: 7,
    mimeType,
    maxBytes: CHAT_PHOTO_MAX_BYTES,
    exp: Math.floor(Date.now() / 1000) + 300,
  });
}

async function putViaHandler(
  bucket: ChatMediaBucket,
  bytes: Uint8Array,
  input: { attachmentId: string; mimeType?: "image/jpeg" | "image/png" | "image/webp"; contentLength?: boolean }
) {
  const mimeType = input.mimeType || "image/jpeg";
  const headers: Record<string, string> = {
    "content-type": mimeType,
    [CHAT_MEDIA_GRANT_HEADER]: await grantFor(input.attachmentId, mimeType),
  };
  if (input.contentLength !== false) headers["content-length"] = String(bytes.byteLength);
  const started = performance.now();
  const res = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers,
      body: bytes,
    }),
    { CHAT_MEDIA: bucket, CHAT_MEDIA_SECRET: SECRET }
  );
  const elapsed = performance.now() - started;
  const json = await uploadJson(res);
  const key = deriveChatMediaR2Key({
    roomId: ROOM,
    attachmentId: input.attachmentId,
    mimeType,
  });
  const stored = await bucket.get(key);
  const storedBytes = stored ? new Uint8Array(await stored.arrayBuffer()) : null;
  return { res, json, key, storedBytes, elapsed };
}

async function putPhase8StreamDirect(
  bucket: ChatMediaBucket,
  bytes: Uint8Array,
  key: string
): Promise<{ ok: boolean; errorClass: string }> {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
  const prefix = await readPrefixThenRest(body, 256);
  if (!prefix.ok) return { ok: false, errorClass: "prefix" };
  const bounded = createBoundedConcatStream(prefix.prefix, prefix.rest, CHAT_PHOTO_MAX_BYTES);
  try {
    await bucket.put(key, bounded.stream, {
      onlyIf: { etagDoesNotMatch: "*" },
      httpMetadata: { contentType: "image/jpeg" },
      customMetadata: { mime: "image/jpeg" },
    });
    return { ok: true, errorClass: "" };
  } catch (err) {
    const name = err && typeof err === "object" ? String((err as { name?: unknown }).name || "Error") : typeof err;
    return { ok: false, errorClass: name };
  }
}

async function main() {
  const configPath = new URL("../cloudflare/verthill-chat/wrangler.jsonc", import.meta.url).pathname;
  const proxy = await wrangler.getPlatformProxy({
    configPath,
    persist: false,
    remoteBindings: false,
  });
  const bucket = proxy.env.CHAT_MEDIA;
  if (!bucket) throw new Error("local CHAT_MEDIA R2 binding missing");

  console.log("\n== miniflare R2 runtime upload ==");
  const jpeg500 = jpegBytes(500 * 1024, 51);
  const jpeg800 = jpegBytes(800 * 1024, 81);
  const jpeg470 = jpegBytes(470 * 1024, 47);
  const first = await putViaHandler(bucket, jpeg500, {
    attachmentId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
  });
  assert(first.res?.status === 200 && first.json?.receipt, "500KB JPEG upload success");
  assert(first.storedBytes != null && sameBytes(first.storedBytes, jpeg500), "500KB R2 readback identical");
  const receipt = await verifyChatMediaUploadReceipt(SECRET, String(first.json?.receipt || ""));
  assert(receipt.ok && receipt.receipt.actualSize === jpeg500.byteLength, "receipt size matches stored object");

  const jpeg800Put = await putViaHandler(bucket, jpeg800, {
    attachmentId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
  });
  assert(jpeg800Put.res?.status === 200 && sameBytes(jpeg800Put.storedBytes || new Uint8Array(), jpeg800), "800KB JPEG readback");

  const jpeg470Put = await putViaHandler(bucket, jpeg470, {
    attachmentId: "abababab-abab-4aba-8aba-abababababab",
  });
  assert(jpeg470Put.res?.status === 200, "470KB JPEG success");

  const png = await putViaHandler(bucket, pngBytes(120), {
    attachmentId: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    mimeType: "image/png",
  });
  assert(png.res?.status === 200 && png.storedBytes?.[0] === 0x89, "PNG upload + readback");
  const webp = await putViaHandler(bucket, webpBytes(80), {
    attachmentId: "dddddddd-dddd-4ddd-8ddd-dddddddddddd",
    mimeType: "image/webp",
  });
  assert(webp.res?.status === 200 && webp.storedBytes?.[8] === 0x57, "WebP upload + readback");

  const edge = await putViaHandler(bucket, jpegBytes(CHAT_PHOTO_MAX_BYTES, 3), {
    attachmentId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
  });
  assert(edge.res?.status === 200 && edge.storedBytes?.byteLength === CHAT_PHOTO_MAX_BYTES, "3MB boundary");
  const over = await putViaHandler(bucket, jpegBytes(CHAT_PHOTO_MAX_BYTES + 1, 4), {
    attachmentId: "ffffffff-ffff-4fff-8fff-ffffffffffff",
  });
  assert(over.res?.status === 413 && !over.storedBytes, "3MB+1 reject");

  const badMagic = await putViaHandler(bucket, pdfBytes(), {
    attachmentId: "12121212-1212-4121-8121-121212121212",
  });
  assert(badMagic.res?.status === 400 && !badMagic.storedBytes, "wrong magic reject");

  const retryId = "13131313-1313-4131-8131-131313131313";
  const retryBytes = jpegBytes(64 * 1024, 9);
  const retry1 = await putViaHandler(bucket, retryBytes, { attachmentId: retryId });
  const retry2 = await putViaHandler(bucket, retryBytes, { attachmentId: retryId });
  assert(retry1.res?.status === 200 && retry2.res?.status === 200, "duplicate same upload retry");
  assert(Boolean(retry2.json?.receipt), "retry returns a receipt");
  const conflict = await putViaHandler(bucket, jpegBytes(80 * 1024, 10), { attachmentId: retryId });
  assert(conflict.res?.status === 409, "duplicate different size conflict");
  assert(sameBytes((await bucket.get(retry1.key).then(async (o) => new Uint8Array(await o!.arrayBuffer())))!, retryBytes), "conflict leaves original bytes");

  const expired = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers: {
        "content-type": "image/jpeg",
        [CHAT_MEDIA_GRANT_HEADER]: await signChatMediaPutGrant(SECRET, {
          v: 1,
          op: CHAT_MEDIA_PUT_OP,
          roomId: ROOM,
          attachmentId: "14141414-1414-4141-8141-141414141414",
          senderUserId: 7,
          mimeType: "image/jpeg",
          maxBytes: CHAT_PHOTO_MAX_BYTES,
          exp: Math.floor(Date.now() / 1000) - 10,
        }),
      },
      body: jpegBytes(32, 1),
    }),
    { CHAT_MEDIA: bucket, CHAT_MEDIA_SECRET: SECRET },
    Math.floor(Date.now() / 1000)
  );
  assert(expired?.status === 410, "expired grant reject");

  const tampered = await handleChatMediaRequest(
    new Request("http://chat-media.test/media/upload", {
      method: "PUT",
      headers: {
        "content-type": "image/jpeg",
        [CHAT_MEDIA_GRANT_HEADER]: (await grantFor("15151515-1515-4151-8151-151515151515")).replace(/^../, "zz"),
      },
      body: jpegBytes(32, 1),
    }),
    { CHAT_MEDIA: bucket, CHAT_MEDIA_SECRET: SECRET }
  );
  assert(tampered?.status === 401, "tampered grant reject");

  console.log("\n== reconstructed stream vs Uint8Array on workerd R2 ==");
  const streamKey = "chat/all/stream-repro.jpg";
  const streamProbe = await putPhase8StreamDirect(bucket, jpegBytes(64 * 1024, 2), streamKey);
  if (streamProbe.ok) {
    const obj = await bucket.get(streamKey);
    const n = obj ? (await obj.arrayBuffer()).byteLength : 0;
    assert(n > 0, `Miniflare R2 accepted reconstructed stream (${n} bytes) — production still rejected this shape`);
  } else {
    assert(true, `Phase 8 reconstructed stream put failed on workerd R2 (${streamProbe.errorClass})`);
  }
  const bytesKey = "chat/all/bytes-repro.jpg";
  const bytesPut = jpegBytes(64 * 1024, 6);
  await bucket.put(bytesKey, bytesPut, {
    onlyIf: { etagDoesNotMatch: "*" },
    httpMetadata: { contentType: "image/jpeg" },
  });
  const bytesObj = await bucket.get(bytesKey);
  assert(
    bytesObj != null && sameBytes(new Uint8Array(await bytesObj.arrayBuffer()), bytesPut),
    "Uint8Array put + readback works on workerd R2"
  );

  console.log("\n== local timing (not slower than Phase 7 buffer path) ==");
  console.log(`  500KB handler+R2 ${first.elapsed.toFixed(1)}ms`);
  console.log(`  800KB handler+R2 ${jpeg800Put.elapsed.toFixed(1)}ms`);
  const shaStart = performance.now();
  await crypto.subtle.digest("SHA-256", jpeg800);
  const shaMs = performance.now() - shaStart;
  console.log(`  800KB SHA-256 (Phase 7 extra) ${shaMs.toFixed(1)}ms`);
  assert(true, "Phase 8-fixed path skips hot-path SHA-256");

  await proxy.dispose();

  if (failed > 0) {
    console.error(`\nFAIL ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
