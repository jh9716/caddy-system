/** Secure 8-part v2. `binding` is parse-time only (not HMAC). */
export type ChatTokenSessionBoundV2Claims = {
  v: 2;
  binding?: "session";
  userId: number;
  displayName: string;
  role: "admin" | "caddy" | "leader";
  team: string;
  /** DB User.sessionVersion. Required on v2. */
  sv: number;
  iat: number;
  exp: number;
  /**
   * 환경 구분(audience). 없으면 production (기존 8-part 토큰 그대로).
   * "preview" 이면 canonical 9번째 칸에 `aud=preview` 가 붙어 HMAC 에 포함된다.
   * 기존(배포된) production Worker 는 9-part 를 파싱하지 않으므로 preview 토큰을 거부한다.
   */
  aud?: ChatTokenAudience;
};

export type ChatTokenV2Claims = ChatTokenSessionBoundV2Claims;

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

export type ChatTokenAudience = "production" | "preview";
export const CHAT_TOKEN_PREVIEW_AUD_PART = "aud=preview";

/** 토큰의 환경. v1 과 aud 없는 v2 는 production. */
export function chatTokenAudience(claims: ChatTokenClaims): ChatTokenAudience {
  return claims.v === 2 && claims.aud === "preview" ? "preview" : "production";
}

/** 설정값 → audience. 비어 있으면 production, 알 수 없는 값은 null(설정 오류, fail-closed). */
export function parseChatTokenAudience(raw: unknown): ChatTokenAudience | null {
  const v = String(raw ?? "").trim().toLowerCase();
  if (v === "" || v === "production") return "production";
  if (v === "preview") return "preview";
  return null;
}

export function isChatTokenV2(claims: ChatTokenClaims): claims is ChatTokenV2Claims {
  return claims.v === 2;
}

export function isSessionBoundChatToken(
  claims: ChatTokenClaims
): claims is ChatTokenSessionBoundV2Claims {
  return claims.v === 2 && parseChatSessionVersion(claims.sv) != null;
}

export function parseChatSessionVersion(raw: unknown): number | null {
  const sv = Number(raw);
  if (!Number.isInteger(sv) || sv < 0) return null;
  return sv;
}

export function chatTokenSessionVersion(claims: ChatTokenClaims): number | null {
  return isSessionBoundChatToken(claims)
    ? parseChatSessionVersion(claims.sv)
    : null;
}

/** True when stored epoch is newer than the token (revoked). Missing epoch is unknown. */
export function isChatSessionEpochStale(
  tokenSv: number | null,
  storedSv: number | null | undefined
): boolean {
  if (storedSv == null) return false;
  if (tokenSv == null) return true;
  return storedSv > tokenSv;
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
    if (!isSessionBoundChatToken(claims)) {
      throw new Error("v2 chat tokens require sessionVersion");
    }
    const parts = [
      "2",
      String(claims.userId),
      sanitizeChatDisplayName(claims.displayName),
      claims.role,
      normalizeTeam(claims.team),
      String(claims.sv),
      String(claims.iat),
      String(claims.exp),
    ];
    if (claims.aud === "preview") parts.push(CHAT_TOKEN_PREVIEW_AUD_PART);
    return parts.join("|");
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
  const previewAud = parts[0] === "2" && parts.length === 9 && parts[8] === CHAT_TOKEN_PREVIEW_AUD_PART;
  if (parts[0] === "2" && (parts.length === 8 || previewAud)) {
    const [, userIdRaw, displayName, role, team, svRaw, iatRaw, expRaw] = parts;
    const userId = Number(userIdRaw);
    const sv = parseChatSessionVersion(svRaw);
    const iat = Number(iatRaw);
    const exp = Number(expRaw);
    if (!Number.isInteger(userId) || userId <= 0) return null;
    if (sv == null) return null;
    if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;
    if (role !== "admin" && role !== "caddy" && role !== "leader") return null;
    const name = sanitizeChatDisplayName(displayName);
    if (!name) return null;
    return {
      v: 2,
      binding: "session",
      userId,
      displayName: name,
      role,
      team: normalizeTeam(team),
      sv,
      iat,
      exp,
      ...(previewAud ? { aud: "preview" as const } : {}),
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
  nowSec = Math.floor(Date.now() / 1000),
  expectedAudience: ChatTokenAudience = "production"
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
  // 환경 교차 차단: production Worker 는 preview 토큰을, preview Worker 는 production 토큰을 거부
  if (chatTokenAudience(claims) !== expectedAudience) return null;
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
  isDm?: boolean;
}): { ok: true } | { ok: false; code: "invalid_room" | "room_forbidden" } {
  if (input.isAll) {
    return input.claims.v === 2 ? { ok: true } : { ok: false, code: "room_forbidden" };
  }
  if (input.isCustom || input.isDm) {
    if (input.claims.v !== 2) return { ok: false, code: "room_forbidden" };
    return input.isMember ? { ok: true } : { ok: false, code: "room_forbidden" };
  }
  if (input.isLegacy) {
    if (input.claims.v === 1 && input.claims.room === input.roomId) return { ok: true };
    return { ok: false, code: "room_forbidden" };
  }
  return { ok: false, code: "invalid_room" };
}
