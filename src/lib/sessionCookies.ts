/**
 * Signed session cookies (HMAC-SHA256 via Web Crypto — Edge + Node).
 * - Legacy unsigned cookies (role / session_user / admin / …) are NEVER trusted for auth.
 * - Middleware: verify signature + expiry + role claim (no DB).
 * - API / requireAdmin: re-verify against DB User.sessionVersion + role.
 */

import type { NextRequest, NextResponse } from "next/server";

/** admin | caddy | leader — leader는 managedTeams로 조 범위 결정 */
export type AppRole = "admin" | "caddy" | "leader";

export const SESSION_COOKIE_NAME = "vh_session";
export const SESSION_MAX_AGE_SEC = 60 * 60 * 8; // 8h

/** Cleared on login/logout; never trusted for authorization after this PR */
export const LEGACY_SESSION_COOKIE_NAMES = [
  "role",
  "session_role",
  "session_user",
  "admin",
] as const;

export type SessionClaims = {
  /** cookie payload format */
  v: 1;
  /** DB User.id — null for env-only accounts */
  uid: number | null;
  username: string;
  role: AppRole;
  /** mirrors User.sessionVersion (0 for env accounts) */
  sv: number;
  iat: number;
  exp: number;
};

export type VerifiedSession = SessionClaims;

const MAX_AGE = SESSION_MAX_AGE_SEC;

/** DB/env role 문자열 → 앱 역할 (ADMIN/STAFF 등 Production 레거시 값 수용) */
export function normalizeAppRole(input: unknown): AppRole | null {
  const raw = String(input ?? "")
    .trim()
    .toLowerCase();
  if (raw === "admin") return "admin";
  if (raw === "leader" || raw === "조장") return "leader";
  if (raw === "caddy" || raw === "staff") return "caddy";
  return null;
}

/** Cloudflare/Vercel 프록시 뒤에서도 HTTPS를 정확히 판별 */
export function isHttpsRequest(req: NextRequest | Request): boolean {
  const forwarded =
    (req as NextRequest).headers?.get?.("x-forwarded-proto") ||
    (req as Request).headers?.get?.("x-forwarded-proto") ||
    "";
  const proto = String(forwarded).split(",")[0]?.trim().toLowerCase();
  if (proto === "https") return true;

  const nextProto =
    typeof (req as NextRequest).nextUrl?.protocol === "string"
      ? (req as NextRequest).nextUrl.protocol.replace(":", "").toLowerCase()
      : "";
  if (nextProto === "https") return true;

  try {
    if (new URL(req.url).protocol === "https:") return true;
  } catch {
    // ignore
  }

  if (process.env.VERCEL === "1") return true;
  return false;
}

export function getSessionSecret(): string {
  const s =
    process.env.SESSION_SECRET ||
    process.env.AUTH_SECRET ||
    process.env.NEXTAUTH_SECRET ||
    "";
  return String(s).trim();
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

function utf8Bytes(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Canonical signing string — field order fixed */
export function canonicalSessionPayload(claims: SessionClaims): string {
  const uid = claims.uid == null ? "" : String(claims.uid);
  return [
    String(claims.v),
    uid,
    claims.username,
    claims.role,
    String(claims.sv),
    String(claims.iat),
    String(claims.exp),
  ].join("|");
}

async function importHmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    utf8Bytes(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"]
  );
}

export async function signSessionClaims(
  claims: SessionClaims,
  secret = getSessionSecret()
): Promise<string> {
  if (!secret) {
    throw new Error("SESSION_SECRET (or AUTH_SECRET/NEXTAUTH_SECRET) is required");
  }
  const canonical = canonicalSessionPayload(claims);
  const key = await importHmacKey(secret);
  const sig = await crypto.subtle.sign("HMAC", key, utf8Bytes(canonical));
  const body = bytesToBase64Url(utf8Bytes(canonical));
  const sigB64 = bytesToBase64Url(new Uint8Array(sig));
  return `${body}.${sigB64}`;
}

function timingSafeEqualBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i]! ^ b[i]!;
  return diff === 0;
}

export async function verifySignedSessionToken(
  token: string | undefined | null,
  opts?: { secret?: string; nowSec?: number }
): Promise<VerifiedSession | null> {
  if (!token || typeof token !== "string") return null;
  const secret = opts?.secret ?? getSessionSecret();
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

  const key = await importHmacKey(secret);
  const expected = new Uint8Array(
    await crypto.subtle.sign("HMAC", key, utf8Bytes(canonical))
  );
  let got: Uint8Array;
  try {
    got = base64UrlToBytes(sigB64);
  } catch {
    return null;
  }
  if (!timingSafeEqualBytes(got, expected)) return null;

  const bits = canonical.split("|");
  if (bits.length !== 7) return null;
  const [vStr, uidStr, username, roleRaw, svStr, iatStr, expStr] = bits;
  if (vStr !== "1") return null;
  const role = normalizeAppRole(roleRaw);
  if (!role) return null;
  if (!username) return null;

  const uid = uidStr === "" ? null : Number(uidStr);
  if (uidStr !== "" && (!Number.isInteger(uid) || (uid as number) < 1)) {
    return null;
  }
  const sv = Number(svStr);
  const iat = Number(iatStr);
  const exp = Number(expStr);
  if (!Number.isInteger(sv) || sv < 0) return null;
  if (!Number.isFinite(iat) || !Number.isFinite(exp)) return null;

  const now = opts?.nowSec ?? Math.floor(Date.now() / 1000);
  if (exp < now) return null;
  if (iat > now + 60) return null;

  return {
    v: 1,
    uid: uid as number | null,
    username,
    role,
    sv,
    iat,
    exp,
  };
}

export function buildSessionClaims(input: {
  userId: number | null;
  username: string;
  role: AppRole;
  sessionVersion: number;
  nowSec?: number;
  maxAgeSec?: number;
}): SessionClaims {
  const now = input.nowSec ?? Math.floor(Date.now() / 1000);
  const maxAge = input.maxAgeSec ?? SESSION_MAX_AGE_SEC;
  return {
    v: 1,
    uid: input.userId,
    username: input.username,
    role: input.role,
    sv: Math.max(0, Math.floor(input.sessionVersion)),
    iat: now,
    exp: now + maxAge,
  };
}

function cookieBase(req: NextRequest | Request, maxAge: number) {
  const secure = isHttpsRequest(req);
  return {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge,
  };
}

/** Issue signed session; clear legacy unsigned cookies. */
export async function applySessionCookies(
  res: NextResponse,
  req: NextRequest | Request,
  input: {
    userId: number | null;
    username: string;
    role: AppRole;
    sessionVersion: number;
  }
) {
  const claims = buildSessionClaims(input);
  const token = await signSessionClaims(claims);
  const base = cookieBase(req, SESSION_MAX_AGE_SEC);
  res.cookies.set(SESSION_COOKIE_NAME, token, base);
  clearLegacySessionCookies(res, req);
}

export function clearLegacySessionCookies(
  res: NextResponse,
  req?: NextRequest | Request
) {
  const secure = req
    ? isHttpsRequest(req)
    : process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const base = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: 0,
  };
  for (const name of LEGACY_SESSION_COOKIE_NAMES) {
    res.cookies.set(name, "", base);
  }
}

export function clearSessionCookies(
  res: NextResponse,
  req?: NextRequest | Request
) {
  const secure = req
    ? isHttpsRequest(req)
    : process.env.VERCEL === "1" || process.env.NODE_ENV === "production";
  const base = {
    path: "/",
    httpOnly: true,
    sameSite: "lax" as const,
    secure,
    maxAge: 0,
  };
  res.cookies.set(SESSION_COOKIE_NAME, "", base);
  for (const name of LEGACY_SESSION_COOKIE_NAMES) {
    res.cookies.set(name, "", base);
  }
}

export function readSessionTokenFromCookies(cookies: {
  get: (name: string) => { value: string } | undefined;
}): string | undefined {
  return cookies.get(SESSION_COOKIE_NAME)?.value;
}

/**
 * Edge-safe: signature + expiry only. Does NOT trust legacy cookies.
 * Does NOT check DB sessionVersion (Node/API layer must).
 */
export async function getVerifiedSessionFromCookies(cookies: {
  get: (name: string) => { value: string } | undefined;
}): Promise<VerifiedSession | null> {
  return verifySignedSessionToken(readSessionTokenFromCookies(cookies));
}

/** @deprecated Prefer getVerifiedSessionFromCookies */
export async function getRoleFromCookies(cookies: {
  get: (name: string) => { value: string } | undefined;
}): Promise<AppRole | null> {
  return (await getVerifiedSessionFromCookies(cookies))?.role ?? null;
}

/** @deprecated Prefer verified session claims */
export async function getUsernameFromCookies(cookies: {
  get: (name: string) => { value: string } | undefined;
}): Promise<string | null> {
  return (await getVerifiedSessionFromCookies(cookies))?.username ?? null;
}

export { MAX_AGE };
