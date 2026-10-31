// TEMPORARY DIAGNOSTIC — remove after Preview 403 diagnosis.
// Vercel Preview(VERCEL_ENV=preview 이고 chat app env 판정도 preview)에서만 동작. 운영에서는 호출 경로 자체가 없음.
// 출력: boolean·열거형만. 비밀값/해시/일부/길이, 헤더 값, 토큰, 사용자 정보 금지.
import { currentChatAppEnv } from "./chatAppEnv";
import {
  CHAT_INTERNAL_AUTH_HEADER,
  CHAT_INTERNAL_AUTH_SKEW_SEC,
  CHAT_INTERNAL_TS_HEADER,
  signChatInternalAuth,
} from "./chatInternalAuth";

export const CHAT_403_DIAG_PREFIX = "[TEMP-DIAG preview-chat-403]";

export function chatInternalDiagEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  return String(env.VERCEL_ENV || "").trim() === "preview" && currentChatAppEnv() === "preview";
}

export type ChatInternalDiag = {
  internal_secret_configured: boolean;
  auth_secret_fallback: boolean;
  ts_header_present: boolean;
  auth_header_present: boolean;
  ts_status: "ok" | "missing" | "malformed" | "skew_past" | "skew_future";
  skew_bucket: "le5s" | "le60s" | "gt60s" | "na";
  hmac_match: boolean;
};

function eq(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

export async function diagnoseChatInternalRequest(
  request: Request,
  path: string,
  env: NodeJS.ProcessEnv = process.env,
  nowSec = Math.floor(Date.now() / 1000)
): Promise<ChatInternalDiag> {
  const internal = String(env.CHAT_INTERNAL_SECRET || "").trim();
  const auth = String(env.CHAT_AUTH_SECRET || "").trim();
  const secret = internal || auth;
  const tsRaw = request.headers.get(CHAT_INTERNAL_TS_HEADER);
  const got = String(request.headers.get(CHAT_INTERNAL_AUTH_HEADER) || "");
  const ts = Number(tsRaw || "");
  let ts_status: ChatInternalDiag["ts_status"] = "ok";
  let skew_bucket: ChatInternalDiag["skew_bucket"] = "na";
  if (!tsRaw) ts_status = "missing";
  else if (!Number.isInteger(ts)) ts_status = "malformed";
  else {
    const skew = nowSec - ts;
    const abs = Math.abs(skew);
    skew_bucket = abs <= 5 ? "le5s" : abs <= 60 ? "le60s" : "gt60s";
    if (abs > CHAT_INTERNAL_AUTH_SKEW_SEC) ts_status = skew > 0 ? "skew_past" : "skew_future";
  }
  let hmac_match = false;
  if (secret && got && Number.isInteger(ts)) {
    try {
      hmac_match = eq(await signChatInternalAuth(secret, path, ts), got);
    } catch {
      hmac_match = false;
    }
  }
  return {
    internal_secret_configured: !!internal,
    auth_secret_fallback: !internal && !!auth,
    ts_header_present: !!tsRaw,
    auth_header_present: !!got,
    ts_status,
    skew_bucket,
    hmac_match,
  };
}

export function formatChatInternalDiag(path: string, verified: boolean, d: ChatInternalDiag): string {
  const safePath = /^\/api\/chat\/[a-z/-]{1,40}$/.test(path) ? path : "other";
  return `${CHAT_403_DIAG_PREFIX} ${JSON.stringify({ path: safePath, verified, ...d })}`;
}
