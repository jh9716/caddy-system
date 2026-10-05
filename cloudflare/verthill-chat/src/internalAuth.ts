export const INTERNAL_AUTH_HEADER = "x-chat-internal-auth";
export const INTERNAL_TS_HEADER = "x-chat-internal-ts";
export const INTERNAL_AUTH_SKEW_SEC = 60;

export type InternalSecretEnv = {
  CHAT_AUTH_SECRET?: string;
  CHAT_INTERNAL_SECRET?: string;
};

export function chatInternalSecret(env: InternalSecretEnv): string {
  return String(env.CHAT_INTERNAL_SECRET || env.CHAT_AUTH_SECRET || "").trim();
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function canonicalInternalAuth(path: string, ts: number): string {
  return `${path}|${ts}`;
}

export async function signInternalAuth(
  secret: string,
  path: string,
  ts: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    utf8Bytes(canonicalInternalAuth(path, ts))
  );
  return bytesToBase64Url(new Uint8Array(sig));
}

export async function internalAuthHeaders(
  secret: string,
  path: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<Record<string, string>> {
  return {
    "content-type": "application/json",
    [INTERNAL_TS_HEADER]: String(nowSec),
    [INTERNAL_AUTH_HEADER]: await signInternalAuth(secret, path, nowSec),
  };
}

export async function verifyInternalRequest(
  request: Request,
  env: InternalSecretEnv,
  path: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const secret = chatInternalSecret(env);
  if (!secret) return false;
  const ts = Number(request.headers.get(INTERNAL_TS_HEADER) || "");
  const gotRaw = request.headers.get(INTERNAL_AUTH_HEADER) || "";
  if (!Number.isInteger(ts) || !gotRaw) return false;
  if (Math.abs(nowSec - ts) > INTERNAL_AUTH_SKEW_SEC) return false;
  const expected = await signInternalAuth(secret, path, ts);
  let got: Uint8Array;
  try {
    const pad = gotRaw.length % 4 === 0 ? "" : "=".repeat(4 - (gotRaw.length % 4));
    got = base64UrlToBytes(gotRaw + pad);
  } catch {
    return false;
  }
  let expectedBytes: Uint8Array;
  try {
    expectedBytes = base64UrlToBytes(expected);
  } catch {
    return false;
  }
  return timingSafeEqualBytes(expectedBytes, got);
}
