/**
 * HMAC for Worker → Next chat push dispatch.
 * Matches cloudflare/verthill-chat/src/internalAuth.ts canonical form.
 */
export const CHAT_INTERNAL_AUTH_HEADER = "x-chat-internal-auth";
export const CHAT_INTERNAL_TS_HEADER = "x-chat-internal-ts";
export const CHAT_INTERNAL_AUTH_SKEW_SEC = 60;
export const CHAT_PUSH_DISPATCH_PATH = "/api/chat/push-dispatch";
export const CHAT_ATTACHMENT_CONSUME_PATH = "/api/chat/attachments/consume";
export const CHAT_ATTACHMENT_CLEANUP_PATH = "/api/chat/attachments/cleanup";

export function chatInternalSecret(env: NodeJS.ProcessEnv = process.env): string {
  return String(env.CHAT_INTERNAL_SECRET || env.CHAT_AUTH_SECRET || "").trim();
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i)! ^ b.charCodeAt(i)!;
  return diff === 0;
}

export function canonicalChatInternalAuth(path: string, ts: number): string {
  return `${path}|${ts}`;
}

export async function signChatInternalAuth(
  secret: string,
  path: string,
  ts: number
): Promise<string> {
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );
  const sig = await crypto.subtle.sign(
    "HMAC",
    key,
    new TextEncoder().encode(canonicalChatInternalAuth(path, ts))
  );
  const bytes = new Uint8Array(sig);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/=/g, "").replace(/\+/g, "-").replace(/\//g, "_");
}

export async function verifyChatInternalRequest(
  request: Request,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<boolean> {
  const secret = chatInternalSecret(env);
  if (!secret) return false;
  const ts = Number(request.headers.get(CHAT_INTERNAL_TS_HEADER) || "");
  const got = String(request.headers.get(CHAT_INTERNAL_AUTH_HEADER) || "");
  if (!Number.isInteger(ts) || !got) return false;
  if (Math.abs(nowSec - ts) > CHAT_INTERNAL_AUTH_SKEW_SEC) return false;
  const expected = await signChatInternalAuth(secret, path, ts);
  return timingSafeEqual(expected, got);
}
