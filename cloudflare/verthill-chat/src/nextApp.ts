/**
 * Worker → Next 앱 서버 간 호출 대상 결정.
 * - 운영(CHAT_TOKEN_AUDIENCE 미설정/"production"): 기존 동작 그대로 (CHAT_PUSH_DISPATCH_URL 에서 origin 유도, 추가 헤더 없음).
 * - Preview("preview"): CHAT_PUSH_DISPATCH_URL 이 검증된 Preview Vercel 호스트일 때만 사용 (fail-closed).
 *   이때만 PREVIEW_APP_BYPASS_SECRET 을 x-vercel-protection-bypass 헤더로 보낸다 (값은 로그 금지).
 */
import { parseChatTokenAudience } from "./token";

export const VERCEL_BYPASS_HEADER = "x-vercel-protection-bypass";
export const PUSH_DISPATCH_PATH = "/api/chat/push-dispatch";

/** Vercel Preview 배포/브랜치 별칭: caddy-system-gt8t-<...>-jh9716s-projects.vercel.app */
const PREVIEW_VERCEL_HOST = /^caddy-system-gt8t-[a-z0-9](?:[a-z0-9-]{0,80}[a-z0-9])?-jh9716s-projects\.vercel\.app$/;
const HOST_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
/** Preview Worker 가 절대 호출하면 안 되는 운영 호스트 */
const PRODUCTION_APP_HOSTS = new Set(["www.verthill.kr", "verthill.kr"]);

export type NextAppEnv = {
  CHAT_PUSH_DISPATCH_URL?: string;
  CHAT_TOKEN_AUDIENCE?: string;
  /** Preview 전용. 쉼표 구분 정확 일치 호스트 (예: 커스텀 Preview 도메인). */
  CHAT_PREVIEW_APP_ALLOWED_HOSTS?: string;
  /** Preview 전용 Worker secret. Vercel "Protection Bypass for Automation" 값. */
  PREVIEW_APP_BYPASS_SECRET?: string;
  /** 로컬 테스트 하네스 전용("1"). 배포 설정·워크플로에는 절대 넣지 않는다 (assert-preview-config 가 검사). */
  CHAT_PREVIEW_LOCAL_HARNESS?: string;
};

export function isPreviewWorker(env: NextAppEnv): boolean {
  return parseChatTokenAudience(env.CHAT_TOKEN_AUDIENCE) === "preview";
}

function allowedExtraHosts(env: NextAppEnv): string[] {
  return String(env.CHAT_PREVIEW_APP_ALLOWED_HOSTS || "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h && h === h.toLowerCase() && !h.endsWith(".") && !h.includes("xn--") &&
      h.split(".").length >= 2 && h.split(".").every((l) => HOST_LABEL.test(l)) && !/^[0-9.]+$/.test(h));
}

/** Preview Worker 가 호출해도 되는 Next 앱 URL 인지 (원문 기준 엄격 검사). */
export function isAllowedPreviewAppUrl(raw: string, env: NextAppEnv): boolean {
  const s = String(raw || "");
  if (!s || s !== s.trim() || s.length > 2048) return false;
  if (/[\s\\%\u0000-\u001f\u007f-\uffff]/.test(s)) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (u.protocol !== "https:") return false;
  if (u.username || u.password || u.port !== "" || u.search || u.hash) return false;
  const m = /^https:\/\/([^/?#]*)/.exec(s);
  if (!m || m[1] !== u.hostname) return false; // 대문자·userinfo·포트 표기·정규화 우회 차단
  if (u.pathname !== "/" && u.pathname !== PUSH_DISPATCH_PATH) return false;
  const host = u.hostname;
  if (PRODUCTION_APP_HOSTS.has(host) || host.endsWith(".verthill.kr")) return false;
  if (PREVIEW_VERCEL_HOST.test(host)) return true;
  return allowedExtraHosts(env).includes(host);
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
  if (isPreviewWorker(env) && !isAllowedPreviewAppUrl(raw, env) && !isLocalHarnessAppUrl(raw, env)) return "";
  return deriveFrom(raw, pathname);
}

/** push-dispatch URL. 운영은 설정값 그대로(기존 동작), Preview 는 검증 후 고정 경로. */
export function nextPushDispatchUrl(env: NextAppEnv): string {
  const raw = String(env.CHAT_PUSH_DISPATCH_URL || "").trim();
  if (!raw) return "";
  if (!isPreviewWorker(env)) return raw;
  return isAllowedPreviewAppUrl(raw, env) || isLocalHarnessAppUrl(raw, env)
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
  if (!isAllowedPreviewAppUrl(`https://${host}`, env)) return {};
  return { [VERCEL_BYPASS_HEADER]: secret };
}
