export type ChatTokenV2Claims = {
  v: 2;
  userId: number;
  displayName: string;
  role: "admin" | "caddy" | "leader";
  team: string;
  iat: number;
  exp: number;
};

export type ChatTokenV1Claims = {
  v: 1;
  userId: number;
  displayName: string;
  role: "admin" | "caddy" | "leader";
  team: string;
  room: string;
  iat: number;
  exp: number;
};

export type ChatTokenClaims = ChatTokenV2Claims | ChatTokenV1Claims;

export function isChatTokenV2(claims: ChatTokenClaims): claims is ChatTokenV2Claims {
  return claims.v === 2;
}

export function sanitizeChatDisplayName(name: string): string {
  return String(name ?? "")
    .replace(/\|/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 64);
}

function normalizeTeam(team: string): string {
  const cleaned = String(team ?? "")
    .replace(/\|/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 32);
  return cleaned || "-";
}

export function canonicalChatTokenPayload(claims: ChatTokenClaims): string {
  if (claims.v === 2) {
    return [
      "2",
      String(claims.userId),
      sanitizeChatDisplayName(claims.displayName),
      claims.role,
      normalizeTeam(claims.team),
      String(claims.iat),
      String(claims.exp),
    ].join("|");
  }
  return [
    "1",
    String(claims.userId),
    sanitizeChatDisplayName(claims.displayName),
    claims.role,
    normalizeTeam(claims.team),
    String(claims.room),
    String(claims.iat),
    String(claims.exp),
  ].join("|");
}

function bytesToBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]!);
  const b64 = btoa(bin);
  return b64.replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

function base64UrlToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const b64 = input.replace(/-/g, "+").replace(/_/g, "/") + pad;
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export function parseChatTokenClaims(canonical: string): ChatTokenClaims | null {
  const parts = canonical.split("|");
  if (parts[0] === "2" && parts.length === 7) {
    const [, userIdRaw, displayName, role, team, iatRaw, expRaw] = parts;
    const userId = Number(userIdRaw);
    const iat = Number(iatRaw);
    const exp = Number(expRaw);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (role !== "admin" && role !== "caddy" && role !== "leader") return null;
    const name = sanitizeChatDisplayName(displayName);
    if (!name) return null;
    return {
      v: 2,
      userId,
      displayName: name,
      role,
      team: normalizeTeam(team),
      iat,
      exp,
    };
  }
  if (parts[0] === "1" && parts.length === 8) {
    const [, userIdRaw, displayName, role, team, room, iatRaw, expRaw] = parts;
    const userId = Number(userIdRaw);
    const iat = Number(iatRaw);
    const exp = Number(expRaw);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (role !== "admin" && role !== "caddy" && role !== "leader") return null;
    const name = sanitizeChatDisplayName(displayName);
    if (!name || !team || !room) return null;
    return {
      v: 1,
      userId,
      displayName: name,
      role,
      team: normalizeTeam(team),
      room,
      iat,
      exp,
    };
  }
  return null;
}

export async function verifyChatToken(
  token: string | undefined | null,
  secret: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ChatTokenClaims | null> {
  if (!token || typeof token !== "string") return null;
  if (!secret) return null;
  const parts = token.split(".");
  if (parts.length !== 2) return null;
  const [bodyB64, sigB64] = parts;
  if (!bodyB64 || !sigB64) return null;
  let canonical: string;
  try {
    canonical = new TextDecoder().decode(base64UrlToBytes(bodyB64));
  } catch {
    return null;
  }
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
    got = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }
  if (!timingSafeEqualBytes(expected, got)) return null;
  const claims = parseChatTokenClaims(canonical);
  if (!claims) return null;
  if (claims.exp <= nowSec) return null;
  if (claims.iat > nowSec + 30) return null;
  return claims;
}

export async function signChatToken(
  claims: ChatTokenClaims,
  secret: string
): Promise<string> {
  const canonical = canonicalChatTokenPayload(claims);
  const key = await crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(canonical));
  return `${bytesToBase64Url(utf8Bytes(canonical))}.${bytesToBase64Url(new Uint8Array(sig))}`;
}

export function resolveChatRoomAccess(input: {
  claims: ChatTokenClaims;
  roomId: string;
  isMember: boolean;
  isAll: boolean;
  isCustom: boolean;
  isLegacy: boolean;
}): { ok: true } | { ok: false; code: "invalid_room" | "room_forbidden" } {
  if (input.isAll) {
    return input.claims.v === 2 ? { ok: true } : { ok: false, code: "room_forbidden" };
  }
  if (input.isCustom) {
    if (input.claims.v !== 2) return { ok: false, code: "room_forbidden" };
    return input.isMember ? { ok: true } : { ok: false, code: "room_forbidden" };
  }
  if (input.isLegacy) {
    if (input.claims.v === 1 && input.claims.room === input.roomId) return { ok: true };
    return { ok: false, code: "room_forbidden" };
  }
  return { ok: false, code: "invalid_room" };
}
