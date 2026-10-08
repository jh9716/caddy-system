/**
 * Chat-only R2 Worker client. CourseReport / Notice stay on Vercel Blob.
 * Read/delete follow the DB key prefix (`r2/chat/...`), not CHAT_PHOTO_STORAGE.
 * Existing `chat/...` rows are always Vercel Blob — never guessed as R2.
 */

import {
  CHAT_INTERNAL_AUTH_HEADER,
  CHAT_INTERNAL_TS_HEADER,
  chatInternalSecret,
  signChatInternalAuth,
} from "@/lib/chatInternalAuth";
import { chatHttpBaseUrl } from "@/lib/chatClientConfig";
import { CHAT_PHOTO_MAX_BYTES } from "@/lib/chatPhotoConstants";
import { CourseReportPhotoStorageError } from "@/lib/courseReportPhotoStorage";
import {
  CHAT_MEDIA_INSPECT_PATH,
  CHAT_MEDIA_OBJECT_PATH,
  CHAT_MEDIA_UPLOAD_PATH,
} from "../../cloudflare/verthill-chat/src/chatMedia";
import {
  CHAT_MEDIA_GRANT_HEADER,
  CHAT_MEDIA_SECRET_ENV,
  chatMediaSecret,
  chatPhotoStorageBackend,
  isChatPhotoR2StorageKey,
  parseChatMediaObjectRef,
} from "../../cloudflare/verthill-chat/src/chatMediaGrant";

export {
  CHAT_MEDIA_GRANT_HEADER,
  CHAT_MEDIA_SECRET_ENV,
  CHAT_PHOTO_R2_DB_PREFIX,
  CHAT_PHOTO_STORAGE_ENV,
  buildChatPhotoR2StorageKey,
  chatMediaSecret,
  chatPhotoStorageBackend,
  isChatPhotoR2StorageKey,
  verifyChatMediaUploadReceipt,
} from "../../cloudflare/verthill-chat/src/chatMediaGrant";

type ChatPhotoR2Global = typeof globalThis & {
  __caddyChatMediaWorkerFetch?: typeof fetch;
};

export function setChatMediaWorkerFetchForTests(fn: typeof fetch | null): void {
  const g = globalThis as ChatPhotoR2Global;
  if (fn) g.__caddyChatMediaWorkerFetch = fn;
  else delete g.__caddyChatMediaWorkerFetch;
}

function workerFetch(): typeof fetch {
  const hooked = (globalThis as ChatPhotoR2Global).__caddyChatMediaWorkerFetch;
  return hooked || fetch;
}

export function chatPhotoR2Configured(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (!chatMediaSecret(env)) return false;
  return Boolean(
    (globalThis as ChatPhotoR2Global).__caddyChatMediaWorkerFetch || chatHttpBaseUrl()
  );
}

export function chatPhotoR2WriteEnabled(
  env: NodeJS.ProcessEnv = process.env
): boolean {
  return chatPhotoStorageBackend(env) === "r2" && chatPhotoR2Configured(env);
}

export function chatMediaUploadUrl(): string {
  const hooked = (globalThis as ChatPhotoR2Global).__caddyChatMediaWorkerFetch;
  if (hooked) return `http://chat-media.test${CHAT_MEDIA_UPLOAD_PATH}`;
  const base = chatHttpBaseUrl();
  if (!base) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  return `${base}${CHAT_MEDIA_UPLOAD_PATH}`;
}

function workerOrigin(): string {
  const hooked = (globalThis as ChatPhotoR2Global).__caddyChatMediaWorkerFetch;
  if (hooked) return "http://chat-media.test";
  const base = chatHttpBaseUrl();
  if (!base) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  return base;
}

function objectRefFromStorageKey(storageKey: string) {
  const ref = parseChatMediaObjectRef(storageKey);
  if (!ref || !isChatPhotoR2StorageKey(storageKey)) {
    throw new CourseReportPhotoStorageError(
      "storage_get_failed",
      "사진 읽기에 실패했습니다.",
      502
    );
  }
  return ref;
}

async function internalHeaders(path: string): Promise<Record<string, string>> {
  const secret = chatInternalSecret();
  if (!secret) {
    throw new CourseReportPhotoStorageError(
      "storage_not_configured",
      "사진 저장소가 설정되지 않았습니다.",
      503
    );
  }
  const ts = Math.floor(Date.now() / 1000);
  return {
    "content-type": "application/json",
    [CHAT_INTERNAL_TS_HEADER]: String(ts),
    [CHAT_INTERNAL_AUTH_HEADER]: await signChatInternalAuth(secret, path, ts),
  };
}

export async function inspectChatPhotoR2(storageKey: string): Promise<{
  size: number;
  contentType: string;
  prefix: Uint8Array;
  magicValid: boolean;
}> {
  const ref = objectRefFromStorageKey(storageKey);
  const res = await workerFetch()(`${workerOrigin()}${CHAT_MEDIA_INSPECT_PATH}`, {
    method: "POST",
    headers: await internalHeaders(CHAT_MEDIA_INSPECT_PATH),
    body: JSON.stringify(ref),
  });
  const body = (await res.json().catch(() => null)) as {
    size?: unknown;
    mimeType?: unknown;
    magicValid?: unknown;
    prefixB64?: unknown;
  } | null;
  if (!res.ok) {
    throw new CourseReportPhotoStorageError(
      "storage_get_failed",
      "사진 읽기에 실패했습니다.",
      502
    );
  }
  const size = Number(body?.size || 0);
  const magicValid = body?.magicValid === true;
  const contentType = String(body?.mimeType || "");
  let prefix = new Uint8Array();
  if (typeof body?.prefixB64 === "string" && body.prefixB64) {
    prefix = Uint8Array.from(Buffer.from(body.prefixB64, "base64"));
  }
  return {
    size: Number.isFinite(size) ? size : 0,
    contentType,
    magicValid,
    prefix,
  };
}

export async function openChatPhotoR2Body(
  storageKey: string,
  abortSignal?: AbortSignal
): Promise<Uint8Array> {
  const ref = objectRefFromStorageKey(storageKey);
  const url = new URL(`${workerOrigin()}${CHAT_MEDIA_OBJECT_PATH}`);
  url.searchParams.set("roomId", ref.roomId);
  url.searchParams.set("attachmentId", ref.attachmentId);
  url.searchParams.set("ext", ref.ext);
  const res = await workerFetch()(url.toString(), {
    method: "GET",
    headers: await internalHeaders(CHAT_MEDIA_OBJECT_PATH),
    signal: abortSignal,
  });
  if (res.status === 404) {
    throw new CourseReportPhotoStorageError("not_found", "사진을 찾을 수 없습니다.", 404);
  }
  if (!res.ok) {
    throw new CourseReportPhotoStorageError(
      "storage_get_failed",
      "사진 읽기에 실패했습니다.",
      502
    );
  }
  const bytes = new Uint8Array(await res.arrayBuffer());
  if (bytes.byteLength > CHAT_PHOTO_MAX_BYTES) {
    throw new CourseReportPhotoStorageError(
      "storage_get_failed",
      "사진 읽기에 실패했습니다.",
      502
    );
  }
  return bytes;
}

export async function deleteChatPhotoR2Object(storageKey: string): Promise<void> {
  const ref = objectRefFromStorageKey(storageKey);
  const res = await workerFetch()(`${workerOrigin()}${CHAT_MEDIA_OBJECT_PATH}`, {
    method: "DELETE",
    headers: await internalHeaders(CHAT_MEDIA_OBJECT_PATH),
    body: JSON.stringify(ref),
  });
  if (!res.ok && res.status !== 404) {
    throw new CourseReportPhotoStorageError(
      "storage_put_failed",
      "사진 저장에 실패했습니다.",
      502
    );
  }
}

export async function putChatPhotoR2Bytes(input: {
  grant: string;
  bytes: Uint8Array;
  contentType: string;
}): Promise<void> {
  const res = await workerFetch()(chatMediaUploadUrl(), {
    method: "PUT",
    headers: {
      "content-type": input.contentType,
      [CHAT_MEDIA_GRANT_HEADER]: input.grant,
    },
    body: input.bytes,
  });
  if (!res.ok) {
    throw new CourseReportPhotoStorageError(
      "storage_put_failed",
      "사진 저장에 실패했습니다.",
      res.status >= 400 && res.status < 500 ? res.status : 502
    );
  }
}
