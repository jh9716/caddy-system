/**
 * Worker 진입부 → ChatRoom DO 내부 인증 확인서 (WS 업그레이드 1회용).
 * - Worker 진입부가 토큰·세션(session-check)·방 권한을 모두 확인한 직후에만 발급한다.
 * - HMAC-SHA256(기존 Worker 내부 비밀값, 새 secret 없음). 서명 문자열은 "ws-assert|" 접두어로
 *   다른 내부 경로(/internal/..., /api/chat/...) 서명과 섞이지 않게 분리한다.
 * - 방 ID + claims 전체 + 발급 시각을 묶고, 유효 시간 15초. 클라이언트가 보낸 같은 이름의 헤더는
 *   Worker 가 전달 전에 지우고 다시 쓴다. DO 는 확인서가 없거나 틀리면 기존 전체 검증으로 처리한다.
 */
import { chatInternalSecret, signInternalAuth, type InternalSecretEnv } from "./internalAuth";
import type { ChatTokenClaims } from "./token";

export const WS_ASSERT_HEADER = "x-chat-ws-assert";
export const WS_ASSERT_TS_HEADER = "x-chat-ws-assert-ts";
export const WS_ASSERT_CLAIMS_HEADER = "x-chat-ws-claims";
export const WS_ASSERT_MAX_AGE_SEC = 15;
const PREFIX = "ws-assert|";

function b64urlEncode(s: string): string {
  const bytes = new TextEncoder().encode(s);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function stripWsAssertionHeaders(headers: Headers): void {
  headers.delete(WS_ASSERT_HEADER);
  headers.delete(WS_ASSERT_TS_HEADER);
  headers.delete(WS_ASSERT_CLAIMS_HEADER);
}

export async function attachWsAssertion(
  headers: Headers,
  env: InternalSecretEnv,
  room: string,
  claims: ChatTokenClaims,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  stripWsAssertionHeaders(headers);
  const secret = chatInternalSecret(env);
  if (!secret) return false;
  const encoded = b64urlEncode(JSON.stringify(claims));
  const sig = await signInternalAuth(secret, `${PREFIX}${room}|${encoded}`, nowSec);
  headers.set(WS_ASSERT_CLAIMS_HEADER, encoded);
  headers.set(WS_ASSERT_TS_HEADER, String(nowSec));
  headers.set(WS_ASSERT_HEADER, sig);
  return true;
}

/** 유효하면 claims, 아니면 null (호출측은 기존 전체 검증으로 진행). */
export async function readWsAssertion(
  headers: Headers,
  env: InternalSecretEnv,
  room: string,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ChatTokenClaims | null> {
  try {
    const secret = chatInternalSecret(env);
    const encoded = headers.get(WS_ASSERT_CLAIMS_HEADER) || "";
    const sig = headers.get(WS_ASSERT_HEADER) || "";
    const ts = Number(headers.get(WS_ASSERT_TS_HEADER) || "");
    if (!secret || !encoded || !sig || !Number.isInteger(ts)) return null;
    if (ts > nowSec + 2 || nowSec - ts > WS_ASSERT_MAX_AGE_SEC) return null;
    const expected = await signInternalAuth(secret, `${PREFIX}${room}|${encoded}`, ts);
    if (!safeEqual(expected, sig)) return null;
    const claims = JSON.parse(b64urlDecode(encoded)) as ChatTokenClaims;
    if (!claims || typeof claims !== "object" || !Number.isInteger(Number((claims as { userId?: unknown }).userId))) return null;
    const exp = Number((claims as { exp?: unknown }).exp);
    if (Number.isFinite(exp) && exp > 0 && exp < nowSec) return null;
    return claims;
  } catch {
    return null;
  }
}
