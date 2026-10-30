/**
 * 채팅 환경(운영/Preview) 구분 — Preview 배포가 운영 채팅 Worker 로 붙는 것을 막는다 (fail-closed).
 * - 서버: VERCEL_ENV, 브라우저: NEXT_PUBLIC_VERCEL_ENV (Vercel 시스템 변수).
 * - 로컬/운영(값 없음·"production"·"development")은 기존 동작 그대로.
 * - Preview 에서는 채팅 주소가 정확히 verthill-chat-preview.<계정>.workers.dev (wss/https) 이거나
 *   CHAT_PREVIEW_ALLOWED_HOSTS(브라우저: NEXT_PUBLIC_CHAT_PREVIEW_ALLOWED_HOSTS)에 명시된 호스트여야 한다.
 * - 운영 Worker(verthill-chat.<계정>.workers.dev)와 CHAT_PRODUCTION_HOSTS 는 항상 거부.
 * 비밀값·URL 값은 로그/응답에 쓰지 않는다.
 */
import type { ChatTokenAudience } from "@/lib/chatToken";

export const PRODUCTION_CHAT_WORKER_NAME = "verthill-chat";
export const PREVIEW_CHAT_WORKER_NAME = "verthill-chat-preview";

type EnvLike = Record<string, string | undefined>;

function readVercelEnv(env?: EnvLike): string {
  if (env) return String(env.VERCEL_ENV || env.NEXT_PUBLIC_VERCEL_ENV || "").trim().toLowerCase();
  // NEXT_PUBLIC_* 는 빌드 시 문자열로 치환되므로 직접 참조해야 한다
  const server = typeof process !== "undefined" ? process.env.VERCEL_ENV : undefined;
  const pub = process.env.NEXT_PUBLIC_VERCEL_ENV;
  return String(server || pub || "").trim().toLowerCase();
}

/** 이 앱 배포가 발급·허용하는 채팅 토큰 환경 */
export function appChatAudience(env?: EnvLike): ChatTokenAudience {
  return readVercelEnv(env) === "preview" ? "preview" : "production";
}

/** 실제 Preview Worker 주소: verthill-chat-preview.<계정 서브도메인 1개 라벨>.workers.dev (정확히 일치) */
const PREVIEW_WORKERS_DEV_HOST = /^verthill-chat-preview\.([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.workers\.dev$/;
const HOSTNAME_LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

export type ChatUrlKind = "ws" | "http";

export type PreviewChatHostOptions = {
  /** "ws" 면 wss: 만, "http" 면 https: 만 허용. 생략 시 둘 중 하나. */
  kind?: ChatUrlKind;
  /** 명시적으로 승인된 커스텀 호스트(정확히 일치). 기본 빈 목록. */
  allowedHosts?: readonly string[];
  /** 운영 채팅 호스트(항상 거부). */
  productionHosts?: readonly string[];
};

/** 쉼표 구분 호스트 목록 → 소문자 정확 호스트명 배열 (형식이 이상한 항목은 버린다) */
export function parseHostList(raw: string | null | undefined): string[] {
  return String(raw || "")
    .split(",")
    .map((h) => h.trim())
    .filter((h) => h.length > 0 && h.length <= 253 && h === h.toLowerCase() && isPlainDnsName(h));
}

function isPlainDnsName(host: string): boolean {
  if (host.endsWith(".")) return false;
  if (host.includes("xn--")) return false; // IDN/punycode 금지
  if (/^[0-9.]+$/.test(host) || host.includes(":") || host.includes("[")) return false; // IP 리터럴 금지
  const labels = host.split(".");
  if (labels.length < 2) return false;
  return labels.every((l) => HOSTNAME_LABEL.test(l));
}

/** 원문 URL 에서 authority 부분(스킴:// 다음 ~ / ? # 전) */
function rawAuthority(raw: string): string | null {
  const m = /^[a-z][a-z0-9+.-]*:\/\/([^/?#]*)/i.exec(raw);
  return m ? m[1]! : null;
}

/**
 * Preview 전용 채팅 주소인지 엄격 검사.
 * - wss/https 만, userinfo·포트·경로·쿼리·해시·IP·punycode·끝 점·대문자·인코딩 우회 금지
 * - 호스트는 verthill-chat-preview.<계정>.workers.dev 이거나 승인 목록과 정확히 일치
 * - 운영 Worker(verthill-chat.<계정>.workers.dev)와 설정된 운영 호스트는 항상 거부
 */
export function isPreviewChatHost(rawUrl: string | null | undefined, opts: PreviewChatHostOptions = {}): boolean {
  const raw = String(rawUrl ?? "");
  if (!raw || raw !== raw.trim() || raw.length > 2048) return false;
  if (/[\s\\\u0000-\u001f\u007f-\uffff]/.test(raw)) return false; // 공백·백슬래시·제어·비ASCII 금지
  if (raw.includes("%")) return false; // 퍼센트 인코딩 금지
  let u: URL;
  try {
    u = new URL(raw);
  } catch {
    return false;
  }
  const allowedProtocols = opts.kind === "ws" ? ["wss:"] : opts.kind === "http" ? ["https:"] : ["wss:", "https:"];
  if (!allowedProtocols.includes(u.protocol)) return false;
  if (u.username || u.password) return false;
  if (u.port !== "") return false;
  if (u.pathname !== "/" && u.pathname !== "") return false;
  if (u.search || u.hash) return false;
  const authority = rawAuthority(raw);
  // 원문 authority 가 파싱 결과와 정확히 같아야 한다 (대문자·@·인코딩·기본포트 표기 등 정규화 우회 차단)
  if (authority == null || authority !== u.host || authority !== u.hostname) return false;
  const host = u.hostname;
  if (!isPlainDnsName(host)) return false;
  const production = new Set([...(opts.productionHosts || [])]);
  if (production.has(host)) return false;
  if (/^verthill-chat\.[^.]+\.workers\.dev$/.test(host)) return false; // 운영 Worker
  if (PREVIEW_WORKERS_DEV_HOST.test(host)) return true;
  return (opts.allowedHosts || []).includes(host);
}

function configuredLists(env?: EnvLike): { allowedHosts: string[]; productionHosts: string[] } {
  // NEXT_PUBLIC_* 는 브라우저 번들에 문자열로 치환되도록 직접 참조
  const allowed = env
    ? env.CHAT_PREVIEW_ALLOWED_HOSTS || env.NEXT_PUBLIC_CHAT_PREVIEW_ALLOWED_HOSTS
    : (typeof process !== "undefined" ? process.env.CHAT_PREVIEW_ALLOWED_HOSTS : undefined) ||
      process.env.NEXT_PUBLIC_CHAT_PREVIEW_ALLOWED_HOSTS;
  const production = env
    ? env.CHAT_PRODUCTION_HOSTS || env.NEXT_PUBLIC_CHAT_PRODUCTION_HOSTS
    : (typeof process !== "undefined" ? process.env.CHAT_PRODUCTION_HOSTS : undefined) ||
      process.env.NEXT_PUBLIC_CHAT_PRODUCTION_HOSTS;
  return { allowedHosts: parseHostList(allowed), productionHosts: parseHostList(production) };
}

export type ChatEnvironmentStatus =
  | { ok: true; audience: ChatTokenAudience }
  | { ok: false; audience: "preview"; code: "chat_preview_unconfigured" | "chat_preview_production_host" };

/**
 * Preview 에서 채팅을 켜도 되는지. 운영/로컬은 항상 ok.
 * Preview: NEXT_PUBLIC_CHAT_WS_URL 필수 + preview 호스트, CHAT_WORKER_URL 은 있으면 preview 호스트여야 함.
 */
export function chatEnvironmentStatus(env?: EnvLike): ChatEnvironmentStatus {
  const audience = appChatAudience(env);
  if (audience !== "preview") return { ok: true, audience };
  const ws = String((env ? env.NEXT_PUBLIC_CHAT_WS_URL : process.env.NEXT_PUBLIC_CHAT_WS_URL) || "").trim();
  const worker = String((env ? env.CHAT_WORKER_URL : process.env.CHAT_WORKER_URL) || "").trim();
  if (!ws) return { ok: false, audience, code: "chat_preview_unconfigured" };
  const lists = configuredLists(env);
  if (!isPreviewChatHost(ws, { kind: "ws", ...lists })) return { ok: false, audience, code: "chat_preview_production_host" };
  if (worker && !isPreviewChatHost(worker, { kind: "http", ...lists })) {
    return { ok: false, audience, code: "chat_preview_production_host" };
  }
  return { ok: true, audience };
}

export const CHAT_PREVIEW_DISABLED_MESSAGE =
  "Preview 전용 채팅 서버가 설정되지 않아 이 환경에서는 채팅을 사용할 수 없습니다.";
