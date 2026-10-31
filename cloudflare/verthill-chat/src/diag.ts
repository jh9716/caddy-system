// TEMPORARY DIAGNOSTIC — remove after Preview 401 diagnosis.
// Preview Worker(CHAT_TOKEN_AUDIENCE=preview)에서만 동작. 운영에서는 아무것도 출력하지 않는다.
// 출력 허용: 경로 템플릿, 열거형 코드, HTTP 상태 숫자, boolean. 토큰·사용자 ID·비밀값(일부/해시/길이)·쿼리·헤더 값 금지.
import { isPreviewWorker, type NextAppEnv } from "./nextApp";
import { verifyChatToken, parseChatTokenClaims, chatTokenAudience, type ChatTokenAudience } from "./token";

export const DIAG_PREFIX = "[TEMP-DIAG preview-chat-401]";

const SAFE_STR = /^[a-z0-9_:/.-]{0,48}$/;
const ALLOWED_KEYS = new Set([
  "path", "stage", "code", "token_reason", "target_status", "dispatch_url_configured", "bypass_configured",
  "internal_secret_configured", "vercel_block_suspect", "sso_redirect", "html_response", "next_error",
  "auth_secret_mismatch_suspect", "internal_secret_mismatch_suspect", "redirect", "status",
]);

/** 경로 템플릿만 (room id 등 식별자 제거). */
export function diagPath(pathname: string): string {
  if (pathname === "/ws" || pathname === "/directory/ws" || pathname === "/directory/rooms") return pathname;
  if (/^\/directory\/rooms\/[^/]+\/members$/.test(pathname)) return "/directory/rooms/:id/members";
  if (/^\/directory\/rooms\/[^/]+$/.test(pathname)) return "/directory/rooms/:id";
  return "other";
}

export type DiagFields = Record<string, string | number | boolean>;

/** 허용 키·안전 값만 남긴 한 줄 JSON. */
export function formatDiag(fields: DiagFields): string {
  const out: DiagFields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (!ALLOWED_KEYS.has(k)) continue;
    if (typeof v === "boolean") out[k] = v;
    else if (typeof v === "number") out[k] = Number.isInteger(v) && v >= 0 && v < 1000 ? v : -1;
    else out[k] = SAFE_STR.test(v) ? v : "redacted";
  }
  return `${DIAG_PREFIX} ${JSON.stringify(out)}`;
}

export function diagEnabled(env: NextAppEnv): boolean {
  return isPreviewWorker(env);
}

export function diagLog(env: NextAppEnv, fields: DiagFields): void {
  if (!diagEnabled(env)) return;
  console.log(formatDiag(fields));
}

export type TokenFailReason =
  | "missing" | "malformed" | "bad_signature" | "invalid_claims" | "audience_mismatch" | "expired" | "iat_future" | "unknown";

function b64uToBytes(input: string): Uint8Array {
  const pad = input.length % 4 === 0 ? "" : "=".repeat(4 - (input.length % 4));
  const bin = atob(input.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** verifyChatToken 실패 후에만 호출. 실패 이유를 열거형으로만 돌려준다 (검증 결과 자체는 바꾸지 않음). */
export async function diagnoseTokenFailure(
  token: string, secret: string, audience: ChatTokenAudience, nowSec = Math.floor(Date.now() / 1000)
): Promise<TokenFailReason> {
  try {
    if (!token) return "missing";
    const parts = token.split(".");
    if (parts.length !== 2 || !parts[0] || !parts[1]) return "malformed";
    let canonical: string;
    try { canonical = new TextDecoder().decode(b64uToBytes(parts[0])); } catch { return "malformed"; }
    const claims = parseChatTokenClaims(canonical);
    // 서명이 맞는지는 만료/aud 를 무시한 재검증으로 판정 (aud 양쪽·먼 미래 시각으로 시도)
    let sigOk = false;
    if (claims) {
      for (const aud of ["production", "preview"] as const) {
        if (await verifyChatToken(token, secret, Math.min(claims.iat, claims.exp - 1), aud)) sigOk = true;
      }
    }
    if (!claims) return "malformed";
    if (!sigOk) {
      // exp<=iat 같은 claim 이상 vs 서명 불일치 구분이 어려우면 bad_signature 로 본다
      return claims.exp <= claims.iat ? "invalid_claims" : "bad_signature";
    }
    if (chatTokenAudience(claims) !== audience) return "audience_mismatch";
    if (claims.exp <= nowSec) return "expired";
    if (claims.iat > nowSec + 30) return "iat_future";
    return "unknown";
  } catch {
    return "unknown";
  }
}

/** session-check 응답에서 안전한 신호만 추출 (본문·헤더 값은 반환하지 않음). */
export async function diagSessionResponse(res: Response): Promise<DiagFields> {
  const ct = (res.headers.get("content-type") || "").toLowerCase();
  const server = (res.headers.get("server") || "").toLowerCase();
  const loc = res.headers.get("location") || "";
  let ssoRedirect = false;
  try { ssoRedirect = !!loc && /(^|\.)vercel\.com$/.test(new URL(loc, "https://x.invalid").hostname); } catch {}
  const html = ct.includes("text/html");
  let nextError = "none";
  if (ct.includes("application/json") && !res.ok) {
    try {
      const j = (await res.clone().json()) as { error?: unknown; code?: unknown };
      const c = String(j.error ?? j.code ?? "");
      nextError = ["forbidden", "invalid_payload", "user_unavailable", "auth_unavailable", "session_check_failed",
        "stale_session", "session_revoked", "chat_blocked"].includes(c) ? c : "other";
    } catch { nextError = "unparseable"; }
  }
  const vercelBlock = (res.status === 401 || res.status === 403) && (html || server === "vercel") && nextError === "none";
  return {
    target_status: res.status,
    html_response: html,
    sso_redirect: ssoRedirect,
    vercel_block_suspect: vercelBlock || ssoRedirect,
    next_error: nextError,
    internal_secret_mismatch_suspect: res.status === 403 && nextError === "forbidden",
  };
}
