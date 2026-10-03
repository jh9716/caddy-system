import { getChatAuthSecret } from "@/lib/chatToken";
import type { ChatInviteMember } from "@/lib/chatUsers";

export const CHAT_DIRECTORY_GRANT_TTL_SEC = 60;

export type ChatDirectoryCreateGrant = {
  v: 1;
  op: "create_room";
  roomId: string;
  name: string;
  ownerUserId: number;
  members: ChatInviteMember[];
  iat: number;
  exp: number;
};

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 =
    typeof btoa === "function"
      ? btoa(bin)
      : Buffer.from(bytes).toString("base64");
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

export function canonicalDirectoryGrant(grant: ChatDirectoryCreateGrant): string {
  const members = grant.members
    .map((m) => `${m.userId}:${m.displayName}:${m.role}:${m.team}`)
    .sort()
    .join(",");
  return [
    String(grant.v),
    grant.op,
    grant.roomId,
    grant.name,
    String(grant.ownerUserId),
    members,
    String(grant.iat),
    String(grant.exp),
  ].join("|");
}

export async function signDirectoryCreateGrant(
  grant: ChatDirectoryCreateGrant,
  secret = getChatAuthSecret()
): Promise<string> {
  if (!secret) throw new Error("CHAT_AUTH_SECRET is required");
  const canonical = canonicalDirectoryGrant(grant);
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(canonical));
  const payload = JSON.stringify(grant);
  return `${bytesToBase64Url(utf8Bytes(payload))}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

export async function verifyDirectoryCreateGrant(
  token: string,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ChatDirectoryCreateGrant | null> {
  if (!token || !secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2 || !parts[0] || !parts[1]) return null;
  let payload: string;
  try {
    payload = new TextDecoder().decode(base64UrlToBytes(parts[0]));
  } catch {
    return null;
  }
  let grant: ChatDirectoryCreateGrant;
  try {
    grant = JSON.parse(payload) as ChatDirectoryCreateGrant;
  } catch {
    return null;
  }
  if (grant.v !== 1 || grant.op !== "create_room") return null;
  const canonical = canonicalDirectoryGrant(grant);
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, utf8Bytes(canonical))
  );
  let got: Uint8Array;
  try {
    got = base64UrlToBytes(parts[1]);
  } catch {
    return null;
  }
  if (!timingSafeEqualBytes(expected, got)) return null;
  if (grant.exp <= nowSec || grant.iat > nowSec + 30) return null;
  return grant;
}
