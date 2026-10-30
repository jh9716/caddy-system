/**
 * 채팅 환경(운영/Preview) 구분 — Preview 배포가 운영 채팅 Worker 로 붙는 것을 막는다 (fail-closed).
 * - 서버: VERCEL_ENV, 브라우저: NEXT_PUBLIC_VERCEL_ENV (Vercel 시스템 변수).
 * - 로컬/운영(값 없음·"production"·"development")은 기존 동작 그대로.
 * - Preview 에서는 채팅 주소 호스트의 첫 라벨에 "preview" 가 있어야 한다
 *   (예: verthill-chat-preview.<sub>.workers.dev). 운영 Worker 이름 "verthill-chat" 은 항상 거부.
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

/** Preview 전용 채팅 호스트인지 (첫 라벨에 preview 포함, 운영 Worker 이름 아님) */
export function isPreviewChatHost(rawUrl: string | null | undefined): boolean {
  const raw = String(rawUrl || "").trim();
  if (!raw) return false;
  let host: string;
  try {
    host = new URL(raw).hostname.toLowerCase();
  } catch {
    return false;
  }
  const first = host.split(".")[0] || "";
  if (first === PRODUCTION_CHAT_WORKER_NAME) return false;
  return first.includes("preview");
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
  if (!isPreviewChatHost(ws)) return { ok: false, audience, code: "chat_preview_production_host" };
  if (worker && !isPreviewChatHost(worker)) return { ok: false, audience, code: "chat_preview_production_host" };
  return { ok: true, audience };
}

export const CHAT_PREVIEW_DISABLED_MESSAGE =
  "Preview 전용 채팅 서버가 설정되지 않아 이 환경에서는 채팅을 사용할 수 없습니다.";
