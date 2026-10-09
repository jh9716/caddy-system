/**
 * Chat-only R2 media handlers.
 * PUT /media/upload uses a short-lived HMAC grant (no Vercel Blob token).
 * First write is create-only via official R2 onlyIf { etagDoesNotMatch: "*" }.
 * The body is read into a bounded Uint8Array (<=3MB) then bucket.put(bytes).
 * Reconstructed unknown-length ReadableStreams are not passed to R2: production
 * R2 + onlyIf rejected that Phase 8 path. Full-file SHA-256 is not on the hot path.
 * Success returns a signed upload receipt. Same-size/mime retries re-issue
 * a receipt; a different size is 409 and never overwrites.
 * Internal inspect/get/delete require CHAT_INTERNAL_SECRET.
 * Client never chooses the object key.
 */

import { verifyInternalRequest } from "./internalAuth";
import {
  CHAT_MEDIA_GRANT_HEADER,
  CHAT_MEDIA_MAGIC_PREFIX_BYTES,
  CHAT_MEDIA_RECEIPT_TTL_SEC,
  CHAT_MEDIA_UPLOADED_OP,
  chatMediaObjectKeyFromRef,
  chatMediaSecret,
  deriveChatMediaR2Key,
  inspectChatMediaMagic,
  parseChatMediaObjectRef,
  signChatMediaUploadReceipt,
  verifyChatMediaPutGrant,
  type ChatMediaGrantSecretEnv,
  type ChatMediaMime,
  type ChatMediaObjectRef,
  type ChatMediaPutGrant,
} from "./chatMediaGrant";

export const CHAT_MEDIA_UPLOAD_PATH = "/media/upload";
export const CHAT_MEDIA_INSPECT_PATH = "/internal/media/inspect";
export const CHAT_MEDIA_OBJECT_PATH = "/internal/media/object";
export { CHAT_MEDIA_GRANT_HEADER } from "./chatMediaGrant";

/** Official R2Conditional create-only: If-None-Match: * */
export const CHAT_MEDIA_CREATE_ONLY: { etagDoesNotMatch: "*" } = { etagDoesNotMatch: "*" };

export type ChatMediaObject = {
  size: number;
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
};

export type ChatMediaPutOnlyIf = {
  etagDoesNotMatch?: string;
};

export type ChatMediaPutOptions = {
  httpMetadata?: { contentType?: string };
  customMetadata?: Record<string, string>;
  onlyIf?: ChatMediaPutOnlyIf | Headers;
};

export type ChatMediaPutValue = ArrayBuffer | Uint8Array | ReadableStream<Uint8Array>;

export type ChatMediaBucket = {
  put(
    key: string,
    value: ChatMediaPutValue,
    options?: ChatMediaPutOptions
  ): Promise<unknown | null>;
  get(
    key: string,
    opts?: { range?: { offset: number; length: number } }
  ): Promise<ChatMediaObject | null>;
  head(key: string): Promise<{
    size: number;
    httpMetadata?: { contentType?: string };
    customMetadata?: Record<string, string>;
  } | null>;
  delete(key: string): Promise<void>;
};

export type ChatMediaEnv = ChatMediaGrantSecretEnv & {
  CHAT_MEDIA?: ChatMediaBucket;
};

type MemoryRow = {
  bytes: Uint8Array;
  contentType: string;
  customMetadata: Record<string, string>;
  etag: string;
};

function onlyIfBlocksExisting(
  existing: MemoryRow | undefined,
  onlyIf?: ChatMediaPutOptions["onlyIf"]
): boolean {
  if (!existing || !onlyIf) return false;
  let etagDoesNotMatch = "";
  if (typeof Headers !== "undefined" && onlyIf instanceof Headers) {
    etagDoesNotMatch = onlyIf.get("if-none-match") || onlyIf.get("If-None-Match") || "";
  } else {
    etagDoesNotMatch = String((onlyIf as ChatMediaPutOnlyIf).etagDoesNotMatch || "");
  }
  return etagDoesNotMatch === "*" || etagDoesNotMatch === existing.etag;
}

async function materializePutValue(value: ChatMediaPutValue): Promise<Uint8Array> {
  if (value instanceof ReadableStream) {
    const reader = value.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    while (true) {
      const { done, value: chunk } = await reader.read();
      if (done) break;
      if (!chunk || chunk.byteLength === 0) continue;
      chunks.push(chunk);
      total += chunk.byteLength;
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return bytes;
  }
  return value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
}

export function createMemoryChatMediaBucket(): ChatMediaBucket {
  const objects = new Map<string, MemoryRow>();
  return {
    async put(key, value, options) {
      const existing = objects.get(key);
      if (onlyIfBlocksExisting(existing, options?.onlyIf)) {
        if (value instanceof ReadableStream) {
          await materializePutValue(value).catch(() => undefined);
        }
        return null;
      }
      const bytes = await materializePutValue(value);
      const row: MemoryRow = {
        bytes,
        contentType: options?.httpMetadata?.contentType || "application/octet-stream",
        customMetadata: { ...(options?.customMetadata || {}) },
        etag: `mem-${bytes.byteLength}-${rowEtag(bytes)}`,
      };
      objects.set(key, row);
      return { key, size: bytes.byteLength, etag: row.etag, customMetadata: row.customMetadata };
    },
    async get(key, opts) {
      const row = objects.get(key);
      if (!row) return null;
      const start = opts?.range?.offset ?? 0;
      const length = opts?.range?.length ?? row.bytes.byteLength - start;
      const slice = row.bytes.subarray(start, start + Math.max(0, length));
      const copy = slice.slice();
      return {
        size: opts?.range ? copy.byteLength : row.bytes.byteLength,
        httpMetadata: { contentType: row.contentType },
        customMetadata: { ...row.customMetadata },
        arrayBuffer: async () =>
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
        body: null,
      };
    },
    async head(key) {
      const row = objects.get(key);
      if (!row) return null;
      return {
        size: row.bytes.byteLength,
        httpMetadata: { contentType: row.contentType },
        customMetadata: { ...row.customMetadata },
      };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
}

function rowEtag(bytes: Uint8Array): string {
  let hash = 0;
  const step = Math.max(1, Math.floor(bytes.byteLength / 32));
  for (let i = 0; i < bytes.byteLength; i += step) hash = (hash * 33 + bytes[i]!) >>> 0;
  return hash.toString(16);
}

export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", bytes));
  let hex = "";
  for (let i = 0; i < digest.byteLength; i++) hex += digest[i]!.toString(16).padStart(2, "0");
  return hex;
}

export type BoundedBodyResult =
  | { ok: true; bytes: Uint8Array }
  | { ok: false; code: "empty_file" | "file_too_large" };

export class ChatMediaStreamLimitError extends Error {
  readonly code = "file_too_large" as const;
  constructor() {
    super("file_too_large");
    this.name = "ChatMediaStreamLimitError";
  }
}

export type PrefixThenRest =
  | { ok: true; prefix: Uint8Array; rest: ReadableStream<Uint8Array> | null }
  | { ok: false; code: "empty_file" };

function concatBytes(chunks: Uint8Array[], total: number): Uint8Array {
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

/**
 * Read at most maxBytes from a request body. The extra byte that trips the
 * limit is discarded and the reader is cancelled so the Worker never holds
 * a >maxBytes file. This is the production PUT body path.
 */
export async function readBoundedBody(
  body: ReadableStream<Uint8Array> | null,
  maxBytes: number
): Promise<BoundedBodyResult> {
  if (!body) return { ok: false, code: "empty_file" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value || value.byteLength === 0) continue;
      if (total + value.byteLength > maxBytes) {
        await reader.cancel();
        return { ok: false, code: "file_too_large" };
      }
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, code: "empty_file" };
  }
  if (total <= 0) return { ok: false, code: "empty_file" };
  return { ok: true, bytes: concatBytes(chunks, total) };
}

/**
 * Pull the first prefixBytes for magic-byte checks, then leave the rest as a
 * stream so the Worker does not buffer the full object.
 */
export async function readPrefixThenRest(
  body: ReadableStream<Uint8Array> | null,
  prefixBytes: number
): Promise<PrefixThenRest> {
  if (!body || prefixBytes <= 0) return { ok: false, code: "empty_file" };
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  let restDone = false;
  try {
    while (total < prefixBytes) {
      const { done, value } = await reader.read();
      if (done) {
        restDone = true;
        break;
      }
      if (!value || value.byteLength === 0) continue;
      chunks.push(value);
      total += value.byteLength;
    }
  } catch {
    await reader.cancel().catch(() => undefined);
    return { ok: false, code: "empty_file" };
  }
  if (total <= 0) {
    await reader.cancel().catch(() => undefined);
    return { ok: false, code: "empty_file" };
  }
  let leftover: Uint8Array | null = null;
  if (total > prefixBytes) {
    const overflow = total - prefixBytes;
    const last = chunks[chunks.length - 1]!;
    const keep = last.byteLength - overflow;
    chunks[chunks.length - 1] = last.subarray(0, keep);
    leftover = last.subarray(keep);
    total = prefixBytes;
  }
  const prefix = concatBytes(chunks, total);
  if (restDone && !leftover) {
    return { ok: true, prefix, rest: null };
  }
  const rest = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (leftover) {
        const extra = leftover;
        leftover = null;
        controller.enqueue(extra);
        return;
      }
      if (restDone) {
        controller.close();
        return;
      }
      try {
        const { done, value } = await reader.read();
        if (done) {
          restDone = true;
          controller.close();
          return;
        }
        if (!value || value.byteLength === 0) return;
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await reader.cancel().catch(() => undefined);
    },
  });
  return { ok: true, prefix, rest };
}

export type BoundedConcatStream = {
  stream: ReadableStream<Uint8Array>;
  getByteCount: () => number;
  completed: () => boolean;
};

/**
 * Re-stitch the magic prefix and remaining body into one stream. A counter
 * cancels the source as soon as maxBytes is exceeded so the Worker never
 * holds a >3MB file.
 */
export function createBoundedConcatStream(
  prefix: Uint8Array,
  rest: ReadableStream<Uint8Array> | null,
  maxBytes: number
): BoundedConcatStream {
  let count = 0;
  let prefixSent = false;
  let finished = false;
  let restReader: ReadableStreamDefaultReader<Uint8Array> | null = rest
    ? rest.getReader()
    : null;
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!prefixSent) {
        prefixSent = true;
        if (prefix.byteLength > maxBytes) {
          await restReader?.cancel().catch(() => undefined);
          controller.error(new ChatMediaStreamLimitError());
          return;
        }
        count += prefix.byteLength;
        if (prefix.byteLength > 0) controller.enqueue(prefix);
        if (!restReader) {
          finished = true;
          controller.close();
        }
        return;
      }
      if (!restReader) {
        finished = true;
        controller.close();
        return;
      }
      try {
        const { done, value } = await restReader.read();
        if (done) {
          finished = true;
          controller.close();
          return;
        }
        if (!value || value.byteLength === 0) return;
        if (count + value.byteLength > maxBytes) {
          await restReader.cancel().catch(() => undefined);
          controller.error(new ChatMediaStreamLimitError());
          return;
        }
        count += value.byteLength;
        controller.enqueue(value);
      } catch (err) {
        controller.error(err);
      }
    },
    async cancel() {
      await restReader?.cancel().catch(() => undefined);
    },
  });
  return {
    stream,
    getByteCount: () => count,
    completed: () => finished,
  };
}

function mediaCorsHeaders(): Record<string, string> {
  return {
    "access-control-allow-origin": "*",
    "access-control-allow-headers": "content-type, authorization, x-chat-media-grant",
    "access-control-allow-methods": "GET, POST, PUT, OPTIONS",
  };
}

function json(data: unknown, status = 200, cors = true): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      ...(cors ? mediaCorsHeaders() : {}),
    },
  });
}

function mediaErrorStatus(code: string): number {
  if (code === "expired") return 410;
  if (code === "file_too_large") return 413;
  if (code === "upload_conflict") return 409;
  if (code === "storage_not_configured") return 503;
  if (code === "server_only" || code === "forbidden") return 403;
  if (code === "not_found") return 404;
  if (code === "unauthorized" || code === "invalid_grant") return 401;
  return 400;
}

function requireBucket(env: ChatMediaEnv): ChatMediaBucket | Response {
  if (!env.CHAT_MEDIA) {
    return json({ error: "storage_not_configured" }, 503);
  }
  return env.CHAT_MEDIA;
}

function parseInternalRef(body: unknown): ChatMediaObjectRef | null {
  if (!body || typeof body !== "object") return null;
  const row = body as Record<string, unknown>;
  const roomId = String(row.roomId || "").trim();
  const attachmentId = String(row.attachmentId || "").trim().toLowerCase();
  const ext = String(row.ext || "").trim().toLowerCase();
  if (ext !== "jpg" && ext !== "png" && ext !== "webp") return null;
  return parseChatMediaObjectRef(`chat/${roomId}/${attachmentId}.${ext}`);
}

async function readJsonBody(request: Request): Promise<unknown> {
  try {
    return await request.json();
  } catch {
    return null;
  }
}

function declaredContentLength(request: Request): number | null {
  const raw = request.headers.get("content-length");
  if (raw == null || raw === "") return null;
  const size = Number(raw);
  if (!Number.isFinite(size) || !Number.isInteger(size) || size < 0) return null;
  return size;
}

function storedMime(meta: {
  customMetadata?: Record<string, string>;
  httpMetadata?: { contentType?: string };
}): string {
  return String(meta.customMetadata?.mime || meta.httpMetadata?.contentType || "");
}

function retryMatchesExisting(
  existing: {
    size: number;
    customMetadata?: Record<string, string>;
    httpMetadata?: { contentType?: string };
  },
  grant: ChatMediaPutGrant,
  candidateSize: number | null
): boolean {
  if (storedMime(existing) !== grant.mimeType) return false;
  if (existing.size <= 0 || existing.size > grant.maxBytes) return false;
  if (candidateSize != null && candidateSize > 0 && candidateSize !== existing.size) return false;
  return true;
}

export const CHAT_MEDIA_UPLOAD_FAILURE_EVENT = "chat_media_upload_failed";

export type ChatMediaUploadStage =
  | "grant"
  | "ingress"
  | "magic"
  | "r2_put"
  | "receipt"
  | "retry"
  | "unknown";

export type ChatMediaUploadFailureLog = {
  event: typeof CHAT_MEDIA_UPLOAD_FAILURE_EVENT;
  stage: ChatMediaUploadStage;
  errorClass: string;
  errorCode: string;
  contentLength: number | null;
  prefixRead: boolean;
  r2PutStarted: boolean;
};

const SAFE_UPLOAD_STAGES = new Set<ChatMediaUploadStage>([
  "grant",
  "ingress",
  "magic",
  "r2_put",
  "receipt",
  "retry",
  "unknown",
]);

function sanitizeLogToken(raw: unknown, fallback = ""): string {
  const text = String(raw ?? "").trim();
  const cleaned = text.replace(/[^A-Za-z0-9_.:-]/g, "").slice(0, 64);
  return cleaned || fallback;
}

export function classifyChatMediaUploadError(err: unknown): { errorClass: string; errorCode: string } {
  if (err && typeof err === "object") {
    const name = sanitizeLogToken((err as { name?: unknown }).name, "Error");
    const code = sanitizeLogToken((err as { code?: unknown }).code);
    return { errorClass: name, errorCode: code };
  }
  return { errorClass: sanitizeLogToken(typeof err, "unknown"), errorCode: "" };
}

export function safeChatMediaUploadFailureLog(input: {
  stage: string;
  error?: unknown;
  contentLength: number | null;
  prefixRead: boolean;
  r2PutStarted: boolean;
}): ChatMediaUploadFailureLog {
  const classified = classifyChatMediaUploadError(input.error);
  const stage = SAFE_UPLOAD_STAGES.has(input.stage as ChatMediaUploadStage)
    ? (input.stage as ChatMediaUploadStage)
    : "unknown";
  return {
    event: CHAT_MEDIA_UPLOAD_FAILURE_EVENT,
    stage,
    errorClass: classified.errorClass,
    errorCode: classified.errorCode,
    contentLength:
      input.contentLength != null && Number.isInteger(input.contentLength) ? input.contentLength : null,
    prefixRead: input.prefixRead === true,
    r2PutStarted: input.r2PutStarted === true,
  };
}

export function emitChatMediaUploadFailure(
  input: Parameters<typeof safeChatMediaUploadFailureLog>[0]
): ChatMediaUploadFailureLog {
  const log = safeChatMediaUploadFailureLog(input);
  console.error(JSON.stringify(log));
  return log;
}

function roundMs(ms: number): number {
  return Math.max(0, Math.round(ms * 10) / 10);
}

function nowMs(): number {
  return typeof performance !== "undefined" && typeof performance.now === "function"
    ? performance.now()
    : Date.now();
}

async function signedUploadReceipt(
  secret: string,
  grant: ChatMediaPutGrant,
  actualSize: number,
  nowSec: number
): Promise<string> {
  return signChatMediaUploadReceipt(secret, {
    v: 1,
    op: CHAT_MEDIA_UPLOADED_OP,
    roomId: grant.roomId,
    attachmentId: grant.attachmentId,
    senderUserId: grant.senderUserId,
    mimeType: grant.mimeType,
    actualSize,
    exp: nowSec + CHAT_MEDIA_RECEIPT_TTL_SEC,
  });
}

async function uploadSuccessResponse(
  secret: string,
  grant: ChatMediaPutGrant,
  actualSize: number,
  nowSec: number,
  timing: { ingressMs: number; storeMs: number }
): Promise<Response> {
  const receipt = await signedUploadReceipt(secret, grant, actualSize, nowSec);
  return json({
    ok: true,
    receipt,
    actualSize,
    mimeType: grant.mimeType,
    timing: {
      ingressMs: roundMs(timing.ingressMs),
      storeMs: roundMs(timing.storeMs),
    },
  });
}

export async function handleChatMediaUpload(
  request: Request,
  env: ChatMediaEnv,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<Response> {
  const started = nowMs();
  let stage: ChatMediaUploadStage = "grant";
  let prefixRead = false;
  let r2PutStarted = false;
  const contentLength = declaredContentLength(request);
  try {
    const bucket = requireBucket(env);
    if (bucket instanceof Response) return bucket;
    const secret = chatMediaSecret(env);
    const verified = await verifyChatMediaPutGrant(
      secret,
      request.headers.get(CHAT_MEDIA_GRANT_HEADER) || "",
      nowSec
    );
    if (!verified.ok) {
      return json({ error: verified.code }, verified.status);
    }
    const grant = verified.grant;
    const declaredType = request.headers.get("content-type") || grant.mimeType;
    const mime = declaredType.toLowerCase().split(";", 1)[0];
    const normalized = mime === "image/jpg" ? "image/jpeg" : mime;
    if (normalized !== grant.mimeType) {
      return json({ error: "unsupported_type" }, 400);
    }
    if (contentLength != null && contentLength > grant.maxBytes) {
      return json({ error: "file_too_large" }, 413);
    }
    if (contentLength === 0) {
      return json({ error: "empty_file" }, 400);
    }
    stage = "ingress";
    const bounded = await readBoundedBody(request.body, grant.maxBytes);
    if (!bounded.ok) return json({ error: bounded.code }, mediaErrorStatus(bounded.code));
    prefixRead = bounded.bytes.byteLength > 0;
    stage = "magic";
    const magic = inspectChatMediaMagic({
      prefix: bounded.bytes,
      totalSize: bounded.bytes.byteLength,
      expectedMime: grant.mimeType,
    });
    if (!magic.ok) {
      return json({ error: magic.code }, mediaErrorStatus(magic.code));
    }
    const ingressMs = nowMs() - started;
    const key = deriveChatMediaR2Key(grant);
    const customMetadata = {
      mime: grant.mimeType,
      size: String(bounded.bytes.byteLength),
    };
    stage = "r2_put";
    r2PutStarted = true;
    const storeStarted = nowMs();
    let created: unknown | null = null;
    try {
      created = await bucket.put(key, bounded.bytes, {
        onlyIf: CHAT_MEDIA_CREATE_ONLY,
        httpMetadata: { contentType: grant.mimeType },
        customMetadata,
      });
    } catch (err) {
      if (err instanceof ChatMediaStreamLimitError) {
        return json({ error: "file_too_large" }, 413);
      }
      emitChatMediaUploadFailure({
        stage: "r2_put",
        error: err,
        contentLength,
        prefixRead,
        r2PutStarted,
      });
      return json({ error: "upload_failed" }, 500);
    }
    const storeMs = nowMs() - storeStarted;
    if (created) {
      if (bounded.bytes.byteLength <= 0) return json({ error: "empty_file" }, 400);
      stage = "receipt";
      return uploadSuccessResponse(secret, grant, bounded.bytes.byteLength, nowSec, {
        ingressMs,
        storeMs,
      });
    }
    stage = "retry";
    const existing = await bucket.head(key);
    if (existing && retryMatchesExisting(existing, grant, bounded.bytes.byteLength)) {
      return uploadSuccessResponse(secret, grant, existing.size, nowSec, { ingressMs, storeMs });
    }
    return json({ error: "upload_conflict" }, 409);
  } catch (err) {
    emitChatMediaUploadFailure({
      stage,
      error: err,
      contentLength,
      prefixRead,
      r2PutStarted,
    });
    return json({ error: "upload_failed" }, 500);
  }
}

export async function handleChatMediaInspect(
  request: Request,
  env: ChatMediaEnv
): Promise<Response> {
  if (request.headers.get("origin")) return json({ error: "server_only" }, 403, false);
  if (!(await verifyInternalRequest(request, env, CHAT_MEDIA_INSPECT_PATH))) {
    return json({ error: "unauthorized" }, 401, false);
  }
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const ref = parseInternalRef(await readJsonBody(request));
  if (!ref) return json({ error: "invalid_payload" }, 400, false);
  const key = chatMediaObjectKeyFromRef(ref);
  const meta = await bucket.head(key);
  if (!meta || meta.size <= 0) {
    return json(
      { ok: true, size: 0, mimeType: "", magicValid: false },
      200,
      false
    );
  }
  const prefixObj = await bucket.get(key, {
    range: { offset: 0, length: CHAT_MEDIA_MAGIC_PREFIX_BYTES },
  });
  const prefix = prefixObj ? new Uint8Array(await prefixObj.arrayBuffer()) : new Uint8Array();
  const expected = ref.ext === "jpg" ? "image/jpeg" : ref.ext === "png" ? "image/png" : "image/webp";
  const magic = inspectChatMediaMagic({
    prefix,
    totalSize: meta.size,
    expectedMime: expected as ChatMediaMime,
  });
  let prefixB64 = "";
  if (prefix.byteLength > 0) {
    let bin = "";
    for (let i = 0; i < prefix.byteLength; i++) bin += String.fromCharCode(prefix[i]!);
    prefixB64 = btoa(bin);
  }
  return json(
    {
      ok: true,
      size: meta.size,
      mimeType: magic.ok ? magic.mimeType : meta.httpMetadata?.contentType || "",
      magicValid: magic.ok,
      prefixB64,
    },
    200,
    false
  );
}

export async function handleChatMediaObjectGet(
  request: Request,
  env: ChatMediaEnv
): Promise<Response> {
  if (request.headers.get("origin")) return json({ error: "server_only" }, 403, false);
  if (!(await verifyInternalRequest(request, env, CHAT_MEDIA_OBJECT_PATH))) {
    return json({ error: "unauthorized" }, 401, false);
  }
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const url = new URL(request.url);
  const ref = parseInternalRef({
    roomId: url.searchParams.get("roomId"),
    attachmentId: url.searchParams.get("attachmentId"),
    ext: url.searchParams.get("ext"),
  });
  if (!ref) return json({ error: "invalid_payload" }, 400, false);
  const obj = await bucket.get(chatMediaObjectKeyFromRef(ref));
  if (!obj) return json({ error: "not_found" }, 404, false);
  const mime =
    obj.httpMetadata?.contentType ||
    (ref.ext === "png" ? "image/png" : ref.ext === "webp" ? "image/webp" : "image/jpeg");
  if (obj.body) {
    return new Response(obj.body, {
      status: 200,
      headers: {
        "content-type": mime,
        "content-length": String(obj.size),
      },
    });
  }
  const bytes = new Uint8Array(await obj.arrayBuffer());
  return new Response(bytes, {
    status: 200,
    headers: {
      "content-type": mime,
      "content-length": String(bytes.byteLength),
    },
  });
}

export async function handleChatMediaObjectDelete(
  request: Request,
  env: ChatMediaEnv
): Promise<Response> {
  if (request.headers.get("origin")) return json({ error: "server_only" }, 403, false);
  if (!(await verifyInternalRequest(request, env, CHAT_MEDIA_OBJECT_PATH))) {
    return json({ error: "unauthorized" }, 401, false);
  }
  const bucket = requireBucket(env);
  if (bucket instanceof Response) return bucket;
  const ref = parseInternalRef(await readJsonBody(request));
  if (!ref) return json({ error: "invalid_payload" }, 400, false);
  await bucket.delete(chatMediaObjectKeyFromRef(ref));
  return json({ ok: true }, 200, false);
}

export async function handleChatMediaRequest(
  request: Request,
  env: ChatMediaEnv,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<Response | null> {
  const url = new URL(request.url);
  if (request.method === "PUT" && url.pathname === CHAT_MEDIA_UPLOAD_PATH) {
    return handleChatMediaUpload(request, env, nowSec);
  }
  if (request.method === "POST" && url.pathname === CHAT_MEDIA_INSPECT_PATH) {
    return handleChatMediaInspect(request, env);
  }
  if (url.pathname === CHAT_MEDIA_OBJECT_PATH) {
    if (request.method === "GET") return handleChatMediaObjectGet(request, env);
    if (request.method === "DELETE") return handleChatMediaObjectDelete(request, env);
  }
  return null;
}
