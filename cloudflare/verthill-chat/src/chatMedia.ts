/**
 * Chat-only R2 media handlers.
 * PUT /media/upload uses a short-lived HMAC grant (no Vercel Blob token).
 * Internal inspect/get/delete require CHAT_INTERNAL_SECRET.
 * Client never chooses the object key.
 */

import { verifyInternalRequest } from "./internalAuth";
import {
  CHAT_MEDIA_GRANT_HEADER,
  CHAT_MEDIA_MAGIC_PREFIX_BYTES,
  chatMediaObjectKeyFromRef,
  chatMediaSecret,
  deriveChatMediaR2Key,
  inspectChatMediaMagic,
  parseChatMediaObjectRef,
  verifyChatMediaPutGrant,
  type ChatMediaGrantSecretEnv,
  type ChatMediaMime,
  type ChatMediaObjectRef,
} from "./chatMediaGrant";

export const CHAT_MEDIA_UPLOAD_PATH = "/media/upload";
export const CHAT_MEDIA_INSPECT_PATH = "/internal/media/inspect";
export const CHAT_MEDIA_OBJECT_PATH = "/internal/media/object";
export { CHAT_MEDIA_GRANT_HEADER } from "./chatMediaGrant";

export type ChatMediaObject = {
  size: number;
  httpMetadata?: { contentType?: string };
  arrayBuffer(): Promise<ArrayBuffer>;
  body?: ReadableStream<Uint8Array> | null;
};

export type ChatMediaBucket = {
  put(
    key: string,
    value: ArrayBuffer | Uint8Array,
    options?: { httpMetadata?: { contentType?: string } }
  ): Promise<unknown>;
  get(
    key: string,
    opts?: { range?: { offset: number; length: number } }
  ): Promise<ChatMediaObject | null>;
  head(key: string): Promise<{ size: number; httpMetadata?: { contentType?: string } } | null>;
  delete(key: string): Promise<void>;
};

export type ChatMediaEnv = ChatMediaGrantSecretEnv & {
  CHAT_MEDIA?: ChatMediaBucket;
};

type MemoryRow = { bytes: Uint8Array; contentType: string };

export function createMemoryChatMediaBucket(): ChatMediaBucket {
  const objects = new Map<string, MemoryRow>();
  return {
    async put(key, value, options) {
      const bytes = value instanceof Uint8Array ? value.slice() : new Uint8Array(value);
      objects.set(key, {
        bytes,
        contentType: options?.httpMetadata?.contentType || "application/octet-stream",
      });
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
        arrayBuffer: async () =>
          copy.buffer.slice(copy.byteOffset, copy.byteOffset + copy.byteLength),
        body: null,
      };
    },
    async head(key) {
      const row = objects.get(key);
      if (!row) return null;
      return { size: row.bytes.byteLength, httpMetadata: { contentType: row.contentType } };
    },
    async delete(key) {
      objects.delete(key);
    },
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

export async function handleChatMediaUpload(
  request: Request,
  env: ChatMediaEnv,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<Response> {
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
  const contentLength = Number(request.headers.get("content-length") || "");
  if (Number.isFinite(contentLength) && contentLength > grant.maxBytes) {
    return json({ error: "file_too_large" }, 413);
  }
  if (!request.body) {
    return json({ error: "empty_file" }, 400);
  }
  const buffer = await request.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  if (bytes.byteLength <= 0) return json({ error: "empty_file" }, 400);
  if (bytes.byteLength > grant.maxBytes) return json({ error: "file_too_large" }, 413);
  const magic = inspectChatMediaMagic({
    prefix: bytes,
    totalSize: bytes.byteLength,
    expectedMime: grant.mimeType,
  });
  if (!magic.ok) return json({ error: magic.code }, mediaErrorStatus(magic.code));

  const key = deriveChatMediaR2Key(grant);
  await bucket.put(key, bytes, { httpMetadata: { contentType: grant.mimeType } });
  return new Response(null, { status: 204, headers: mediaCorsHeaders() });
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
