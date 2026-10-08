/**
 * Chat photo R2 upload grant + key derivation.
 * Next-safe: no R2, Durable Objects, or Cloudflare runtime imports.
 * Grant never includes storage keys, credentials, or R2 secrets.
 */

import {
  CHAT_ATTACHMENT_ID_RE,
  CHAT_PHOTO_MAX_BYTES,
  CHAT_PHOTO_MIMES,
  isValidRoomName,
} from "./protocol";

export const CHAT_MEDIA_PUT_OP = "chat_media_put";
export const CHAT_MEDIA_UPLOADED_OP = "chat_media_uploaded";
export const CHAT_MEDIA_GRANT_HEADER = "x-chat-media-grant";
export const CHAT_MEDIA_GRANT_TTL_SEC = 5 * 60;
export const CHAT_MEDIA_RECEIPT_TTL_SEC = 5 * 60;
export const CHAT_MEDIA_MAGIC_PREFIX_BYTES = 256;
export const CHAT_MEDIA_R2_KEY_PREFIX = "chat/";
export const CHAT_PHOTO_R2_DB_PREFIX = "r2/";
export const CHAT_PHOTO_STORAGE_ENV = "CHAT_PHOTO_STORAGE";
export const CHAT_MEDIA_SECRET_ENV = "CHAT_MEDIA_SECRET";

export type ChatMediaMime = (typeof CHAT_PHOTO_MIMES)[number];

export const CHAT_MEDIA_EXT: Record<ChatMediaMime, "jpg" | "png" | "webp"> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
};

export type ChatMediaPutGrant = {
  v: 1;
  op: typeof CHAT_MEDIA_PUT_OP;
  roomId: string;
  attachmentId: string;
  senderUserId: number;
  mimeType: ChatMediaMime;
  maxBytes: number;
  exp: number;
};

export type ChatMediaGrantSecretEnv = {
  CHAT_MEDIA_SECRET?: string;
  CHAT_INTERNAL_SECRET?: string;
  CHAT_AUTH_SECRET?: string;
};

export type ChatMediaUploadReceipt = {
  v: 1;
  op: typeof CHAT_MEDIA_UPLOADED_OP;
  roomId: string;
  attachmentId: string;
  senderUserId: number;
  mimeType: ChatMediaMime;
  actualSize: number;
  exp: number;
};

export type ChatMediaGrantVerifyOk = { ok: true; grant: ChatMediaPutGrant };
export type ChatMediaGrantVerifyErr = {
  ok: false;
  code: "unauthorized" | "expired" | "invalid_grant";
  status: number;
};
export type ChatMediaGrantVerifyResult = ChatMediaGrantVerifyOk | ChatMediaGrantVerifyErr;

export type ChatMediaReceiptVerifyOk = { ok: true; receipt: ChatMediaUploadReceipt };
export type ChatMediaReceiptVerifyErr = {
  ok: false;
  code: "unauthorized" | "expired" | "invalid_receipt";
  status: number;
};
export type ChatMediaReceiptVerifyResult = ChatMediaReceiptVerifyOk | ChatMediaReceiptVerifyErr;

export type ChatMediaObjectRef = {
  roomId: string;
  attachmentId: string;
  ext: "jpg" | "png" | "webp";
};

export function chatPhotoStorageBackend(
  env: { CHAT_PHOTO_STORAGE?: string } = typeof process !== "undefined" ? process.env : {}
): "r2" | "blob" {
  return String(env.CHAT_PHOTO_STORAGE || "").trim().toLowerCase() === "r2" ? "r2" : "blob";
}

/** Prefer CHAT_MEDIA_SECRET so upload grants are not the same secret as internal admin APIs. */
export function chatMediaSecret(env: ChatMediaGrantSecretEnv): string {
  return String(
    env.CHAT_MEDIA_SECRET || env.CHAT_INTERNAL_SECRET || env.CHAT_AUTH_SECRET || ""
  ).trim();
}

export function normalizeChatMediaMime(raw: unknown): ChatMediaMime | null {
  const value = String(raw || "")
    .trim()
    .toLowerCase()
    .split(";", 1)[0];
  const mime = value === "image/jpg" ? "image/jpeg" : value;
  return (CHAT_PHOTO_MIMES as readonly string[]).includes(mime) ? (mime as ChatMediaMime) : null;
}

export function mimeFromChatMediaExt(ext: string): ChatMediaMime | null {
  if (ext === "jpg") return "image/jpeg";
  if (ext === "png") return "image/png";
  if (ext === "webp") return "image/webp";
  return null;
}

export function isChatPhotoR2StorageKey(storageKey: string): boolean {
  return storageKey.startsWith(`${CHAT_PHOTO_R2_DB_PREFIX}${CHAT_MEDIA_R2_KEY_PREFIX}`);
}

export function deriveChatMediaR2Key(input: {
  roomId: string;
  attachmentId: string;
  mimeType: ChatMediaMime;
}): string {
  return `${CHAT_MEDIA_R2_KEY_PREFIX}${input.roomId}/${input.attachmentId}.${CHAT_MEDIA_EXT[input.mimeType]}`;
}

export function buildChatPhotoR2StorageKey(
  roomId: string,
  mime: ChatMediaMime,
  attachmentId: string
): string {
  return `${CHAT_PHOTO_R2_DB_PREFIX}${deriveChatMediaR2Key({
    roomId,
    attachmentId,
    mimeType: mime,
  })}`;
}

export function parseChatMediaObjectRef(
  storageKey: string
): ChatMediaObjectRef | null {
  const objectKey = isChatPhotoR2StorageKey(storageKey)
    ? storageKey.slice(CHAT_PHOTO_R2_DB_PREFIX.length)
    : storageKey.startsWith(CHAT_MEDIA_R2_KEY_PREFIX)
      ? storageKey
      : "";
  const match = /^chat\/([^/]+)\/([0-9a-f-]{36})\.(jpg|png|webp)$/i.exec(objectKey);
  if (!match) return null;
  const roomId = match[1] || "";
  const attachmentId = (match[2] || "").toLowerCase();
  const ext = (match[3] || "").toLowerCase() as ChatMediaObjectRef["ext"];
  if (!isValidRoomName(roomId) || !CHAT_ATTACHMENT_ID_RE.test(attachmentId)) return null;
  if (ext !== "jpg" && ext !== "png" && ext !== "webp") return null;
  return { roomId, attachmentId, ext };
}

export function chatMediaObjectKeyFromRef(ref: ChatMediaObjectRef): string {
  return `${CHAT_MEDIA_R2_KEY_PREFIX}${ref.roomId}/${ref.attachmentId}.${ref.ext}`;
}

export function canonicalChatMediaPutGrant(grant: ChatMediaPutGrant): string {
  return [
    String(grant.v),
    grant.op,
    grant.roomId,
    grant.attachmentId,
    String(grant.senderUserId),
    grant.mimeType,
    String(grant.maxBytes),
    String(grant.exp),
  ].join("|");
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 =
    typeof btoa === "function" ? btoa(bin) : Buffer.from(bytes).toString("base64");
  return b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  if (typeof atob === "function") {
    const bin = atob(b64);
    const out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  return new Uint8Array(Buffer.from(b64, "base64"));
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

function parseGrantPayload(raw: unknown): ChatMediaPutGrant | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const mime = normalizeChatMediaMime(row.mimeType);
  const roomId = String(row.roomId || "").trim();
  const attachmentId = String(row.attachmentId || "").trim().toLowerCase();
  const senderUserId = Number(row.senderUserId);
  const maxBytes = Number(row.maxBytes);
  const exp = Number(row.exp);
  if (row.v !== 1 || row.op !== CHAT_MEDIA_PUT_OP || !mime) return null;
  if (!isValidRoomName(roomId) || !CHAT_ATTACHMENT_ID_RE.test(attachmentId)) return null;
  if (!Number.isInteger(senderUserId) || senderUserId <= 0) return null;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || maxBytes > CHAT_PHOTO_MAX_BYTES) return null;
  if (!Number.isFinite(exp) || !Number.isInteger(exp) || exp <= 0) return null;
  return {
    v: 1,
    op: CHAT_MEDIA_PUT_OP,
    roomId,
    attachmentId,
    senderUserId,
    mimeType: mime,
    maxBytes,
    exp,
  };
}

async function hmacSha256(secret: string, value: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  return new Uint8Array(await crypto.subtle.sign("HMAC", key, utf8Bytes(value)));
}

export async function signChatMediaPutGrant(
  secret: string,
  grant: ChatMediaPutGrant
): Promise<string> {
  const key = String(secret || "").trim();
  if (!key) throw new Error("CHAT_MEDIA_SECRET is required");
  const parsed = parseGrantPayload(grant);
  if (!parsed) throw new Error("invalid chat media grant");
  const payload = JSON.stringify(parsed);
  const sig = await hmacSha256(key, canonicalChatMediaPutGrant(parsed));
  return `${bytesToBase64Url(utf8Bytes(payload))}.${bytesToBase64Url(sig)}`;
}

export function canonicalChatMediaUploadReceipt(receipt: ChatMediaUploadReceipt): string {
  return [
    String(receipt.v),
    receipt.op,
    receipt.roomId,
    receipt.attachmentId,
    String(receipt.senderUserId),
    receipt.mimeType,
    String(receipt.actualSize),
    String(receipt.exp),
  ].join("|");
}

function parseReceiptPayload(raw: unknown): ChatMediaUploadReceipt | null {
  if (!raw || typeof raw !== "object") return null;
  const row = raw as Record<string, unknown>;
  const mime = normalizeChatMediaMime(row.mimeType);
  const roomId = String(row.roomId || "").trim();
  const attachmentId = String(row.attachmentId || "").trim().toLowerCase();
  const senderUserId = Number(row.senderUserId);
  const actualSize = Number(row.actualSize);
  const exp = Number(row.exp);
  if (row.v !== 1 || row.op !== CHAT_MEDIA_UPLOADED_OP || !mime) return null;
  if (!isValidRoomName(roomId) || !CHAT_ATTACHMENT_ID_RE.test(attachmentId)) return null;
  if (!Number.isInteger(senderUserId) || senderUserId <= 0) return null;
  if (!Number.isInteger(actualSize) || actualSize <= 0 || actualSize > CHAT_PHOTO_MAX_BYTES) {
    return null;
  }
  if (!Number.isFinite(exp) || !Number.isInteger(exp) || exp <= 0) return null;
  return {
    v: 1,
    op: CHAT_MEDIA_UPLOADED_OP,
    roomId,
    attachmentId,
    senderUserId,
    mimeType: mime,
    actualSize,
    exp,
  };
}

export async function signChatMediaUploadReceipt(
  secret: string,
  receipt: ChatMediaUploadReceipt
): Promise<string> {
  const key = String(secret || "").trim();
  if (!key) throw new Error("CHAT_MEDIA_SECRET is required");
  const parsed = parseReceiptPayload(receipt);
  if (!parsed) throw new Error("invalid chat media receipt");
  const payload = JSON.stringify(parsed);
  const sig = await hmacSha256(key, canonicalChatMediaUploadReceipt(parsed));
  return `${bytesToBase64Url(utf8Bytes(payload))}.${bytesToBase64Url(sig)}`;
}

export async function verifyChatMediaUploadReceipt(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ChatMediaReceiptVerifyResult> {
  const key = String(secret || "").trim();
  if (!key || !token) return { ok: false, code: "unauthorized", status: 401 };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: "invalid_receipt", status: 401 };
  }
  let payload: string;
  try {
    payload = new TextDecoder().decode(base64UrlToBytes(parts[0]));
  } catch {
    return { ok: false, code: "invalid_receipt", status: 401 };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, code: "invalid_receipt", status: 401 };
  }
  const receipt = parseReceiptPayload(raw);
  if (!receipt) return { ok: false, code: "invalid_receipt", status: 401 };
  let got: Uint8Array;
  try {
    got = base64UrlToBytes(parts[1]);
  } catch {
    return { ok: false, code: "invalid_receipt", status: 401 };
  }
  const expected = await hmacSha256(key, canonicalChatMediaUploadReceipt(receipt));
  if (!timingSafeEqualBytes(expected, got)) {
    return { ok: false, code: "unauthorized", status: 401 };
  }
  if (receipt.exp <= nowSec) return { ok: false, code: "expired", status: 410 };
  return { ok: true, receipt };
}

export async function verifyChatMediaPutGrant(
  secret: string,
  token: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ChatMediaGrantVerifyResult> {
  const key = String(secret || "").trim();
  if (!key || !token) return { ok: false, code: "unauthorized", status: 401 };
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) {
    return { ok: false, code: "invalid_grant", status: 401 };
  }
  let payload: string;
  try {
    payload = new TextDecoder().decode(base64UrlToBytes(parts[0]));
  } catch {
    return { ok: false, code: "invalid_grant", status: 401 };
  }
  let raw: unknown;
  try {
    raw = JSON.parse(payload);
  } catch {
    return { ok: false, code: "invalid_grant", status: 401 };
  }
  const grant = parseGrantPayload(raw);
  if (!grant) return { ok: false, code: "invalid_grant", status: 401 };
  let got: Uint8Array;
  try {
    got = base64UrlToBytes(parts[1]);
  } catch {
    return { ok: false, code: "invalid_grant", status: 401 };
  }
  const expected = await hmacSha256(key, canonicalChatMediaPutGrant(grant));
  if (!timingSafeEqualBytes(expected, got)) {
    return { ok: false, code: "unauthorized", status: 401 };
  }
  if (grant.exp <= nowSec) return { ok: false, code: "expired", status: 410 };
  return { ok: true, grant };
}

function startsWith(bytes: Uint8Array, sig: number[]): boolean {
  if (bytes.length < sig.length) return false;
  return sig.every((b, i) => bytes[i] === b);
}

function isHeic(bytes: Uint8Array): boolean {
  if (bytes.length < 12) return false;
  if (bytes[4] !== 0x66 || bytes[5] !== 0x74 || bytes[6] !== 0x79 || bytes[7] !== 0x70) {
    return false;
  }
  const brand = String.fromCharCode(bytes[8], bytes[9], bytes[10], bytes[11]).toLowerCase();
  return (
    brand === "heic" ||
    brand === "heix" ||
    brand === "hevc" ||
    brand === "hevx" ||
    brand === "mif1" ||
    brand === "msf1"
  );
}

function isPdf(bytes: Uint8Array): boolean {
  return startsWith(bytes, [0x25, 0x50, 0x44, 0x46]);
}

function looksLikeSvgOrHtml(bytes: Uint8Array): boolean {
  const head = new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, CHAT_MEDIA_MAGIC_PREFIX_BYTES))
    .trimStart()
    .toLowerCase();
  return (
    head.startsWith("<svg") ||
    head.startsWith("<?xml") ||
    head.startsWith("<!doctype html") ||
    head.startsWith("<html")
  );
}

export function detectChatMediaMime(bytes: Uint8Array): ChatMediaMime | null {
  if (startsWith(bytes, [0xff, 0xd8, 0xff])) return "image/jpeg";
  if (startsWith(bytes, [0x89, 0x50, 0x4e, 0x47])) return "image/png";
  if (
    bytes.length >= 12 &&
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  return null;
}

export function inspectChatMediaMagic(input: {
  prefix: Uint8Array;
  totalSize: number;
  expectedMime?: ChatMediaMime;
}):
  | { ok: true; mimeType: ChatMediaMime }
  | { ok: false; code: "empty_file" | "file_too_large" | "unsupported_type" } {
  const totalSize = input.totalSize;
  if (!Number.isFinite(totalSize) || totalSize <= 0 || input.prefix.byteLength === 0) {
    return { ok: false, code: "empty_file" };
  }
  if (totalSize > CHAT_PHOTO_MAX_BYTES) {
    return { ok: false, code: "file_too_large" };
  }
  const prefix =
    input.prefix.byteLength > CHAT_MEDIA_MAGIC_PREFIX_BYTES
      ? input.prefix.subarray(0, CHAT_MEDIA_MAGIC_PREFIX_BYTES)
      : input.prefix;
  if (isHeic(prefix) || isPdf(prefix) || looksLikeSvgOrHtml(prefix)) {
    return { ok: false, code: "unsupported_type" };
  }
  const mime = detectChatMediaMime(prefix);
  if (!mime) return { ok: false, code: "unsupported_type" };
  if (input.expectedMime && mime !== input.expectedMime) {
    return { ok: false, code: "unsupported_type" };
  }
  return { ok: true, mimeType: mime };
}
