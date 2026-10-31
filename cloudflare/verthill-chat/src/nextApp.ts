/**
 * Worker → Next 앱 서버 간 호출 대상 결정.
 * - 운영(CHAT_TOKEN_AUDIENCE 미설정/"production"): 기존 동작 그대로 (CHAT_PUSH_DISPATCH_URL 에서 origin 유도, 추가 헤더 없음).
 * - Preview("preview"): CHAT_PUSH_DISPATCH_URL 이 검증된 Preview Vercel 호스트일 때만 사용 (fail-closed).
 *   이때만 PREVIEW_APP_BYPASS_SECRET 을 x-vercel-protection-bypass 헤더로 보낸다 (값은 로그 금지).
 */
import { parseChatTokenAudience } from "./token";

export const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";
export const PUSH_DISPATCH_PATH = "/api/chat/push-dispatch";

/** 허용되는 유일한 Preview Next 호스트 (Vercel 브랜치 별칭). 설정으로 넓힐 수 없다. */
export const PREVIEW_APP_HOST = "caddy-system-gt8t-git-preview-db-workflow-jh9716s-projects.vercel.app";
/** bypass 헤더를 붙여도 되는 Next 내부 호출 경로 (정확 일치). */
const NEXT_CALL_PATHS = new Set([
  "/api/chat/session-check",
  "/api/chat/attachments/cleanup",
  "/api/chat/attachments/consume",
  PUSH_DISPATCH_PATH,
]);
const ALLOWED_PATHS = new Set(["/", PUSH_DISPATCH_PATH]);

export type NextAppEnv = {
  CHAT_PUSH_DISPATCH_URL?: string;
  CHAT_TOKEN_AUDIENCE?: string;
  /** Preview 전용 Worker secret. 배포 보호 자동화 우회 값. */
  PREVIEW_APP_BYPASS_SECRET?: string;
  /** 로컬 테스트 하네스 전용("1"). 배포 설정·워크플로에는 절대 넣지 않는다 (assert-preview-config 가 검사). */
  CHAT_PREVIEW_LOCAL_HARNESS?: string;
};

export function isPreviewWorker(env: NextAppEnv): boolean {
  return parseChatTokenAudience(env.CHAT_TOKEN_AUDIENCE) === "preview";
}

/** Preview Worker 가 호출해도 되는 Next 앱 URL 인지: 원문이 정확히 https://<PREVIEW_APP_HOST>[/|/api/chat/push-dispatch]. */
export function isAllowedPreviewAppUrl(raw: string, _env?: NextAppEnv): boolean {
  const s = String(raw ?? "");
  const prefix = `https://${PREVIEW_APP_HOST}`;
  if (s !== prefix && !s.startsWith(prefix + "/")) return false; // 원문 정확 비교: 대문자·userinfo·포트·끝점·유사 호스트 차단
  const rest = s.slice(prefix.length) || "/";
  if (!ALLOWED_PATHS.has(rest)) return false; // 쿼리·fragment·인코딩·기타 경로 차단
  try {
    const u = new URL(s);
    return u.protocol === "https:" && u.hostname === PREVIEW_APP_HOST && u.port === "" &&
      !u.username && !u.password && ALLOWED_PATHS.has(u.pathname) && !u.search && !u.hash;
  } catch {
    return false;
  }
}

/** 로컬 하네스: http://127.0.0.1:<port> 만. bypass 헤더는 이 경로로 절대 보내지 않는다. */
export function isLocalHarnessAppUrl(raw: string, env: NextAppEnv): boolean {
  if (String(env.CHAT_PREVIEW_LOCAL_HARNESS || "") !== "1") return false;
  return /^http:\/\/127\.0\.0\.1:[0-9]{2,5}\/?$/.test(String(raw || ""));
}

function deriveFrom(raw: string, pathname: string): string {
  try {
    const parsed = new URL(raw);
    parsed.pathname = pathname;
    parsed.search = "";
    return parsed.toString();
  } catch {
    return "";
  }
}

/** Next 앱의 내부 경로 URL. 운영은 기존과 동일, Preview 는 검증 실패 시 "" (호출 안 함). */
export function nextAppUrl(env: NextAppEnv, pathname: string): string {
  const raw = String(env.CHAT_PUSH_DISPATCH_URL || "").trim();
  if (!raw) return "";
  const exact = String(env.CHAT_PUSH_DISPATCH_URL || ""); // Preview 는 trim 전 원문으로 검증
  if (isPreviewWorker(env) && !isAllowedPreviewAppUrl(exact) && !isLocalHarnessAppUrl(exact, env)) return "";
  return deriveFrom(raw, pathname);
}

/** push-dispatch URL. 운영은 설정값 그대로(기존 동작), Preview 는 검증 후 고정 경로. */
export function nextPushDispatchUrl(env: NextAppEnv): string {
  const raw = String(env.CHAT_PUSH_DISPATCH_URL || "").trim();
  if (!raw) return "";
  if (!isPreviewWorker(env)) return raw;
  const exact = String(env.CHAT_PUSH_DISPATCH_URL || "");
  return isAllowedPreviewAppUrl(exact) || isLocalHarnessAppUrl(exact, env)
    ? deriveFrom(raw, PUSH_DISPATCH_PATH)
    : "";
}

/** Next 호출에 덧붙일 헤더. Preview Worker + 검증된 Preview 호스트 + secret 있을 때만 bypass 헤더. 운영은 항상 {}. */
export function nextAppExtraHeaders(env: NextAppEnv, url: string): Record<string, string> {
  if (!isPreviewWorker(env)) return {};
  const secret = String(env.PREVIEW_APP_BYPASS_SECRET || "").trim();
  if (!secret || !url) return {};
  let host = "";
  try {
    host = new URL(url).hostname;
  } catch {
    return {};
  }
  if (host !== PREVIEW_APP_HOST || !isAllowedPreviewAppUrl(`https://${host}`)) return {};
  if (!NEXT_CALL_PATHS.has(url.slice(`https://${PREVIEW_APP_HOST}`.length)) || !url.startsWith(`https://${PREVIEW_APP_HOST}/`)) return {};
  return { [VERCEL_BYPASS_HEADER]: secret };
}

/**
 * Next 호출 fetch 추가 옵션. Preview: redirect 를 따라가지 않음(비밀 헤더 재전송 방지).
 * 운영: {} — 기존 fetch 옵션 그대로(기존처럼 redirect 를 따라감).
 */
export function nextAppFetchInit(env: NextAppEnv): { redirect?: "manual" } {
  return isPreviewWorker(env) ? { redirect: "manual" } : {};
}

/** 3xx / opaqueredirect / status 0 → 리다이렉트(실패로 처리). */
export function isRedirectResponse(res: { status: number; type?: string }): boolean {
  return res.type === "opaqueredirect" || res.status === 0 || (res.status >= 300 && res.status < 400);
}
