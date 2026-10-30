/**
 * 채팅 앱 환경(운영/Preview) 단일 판정기. 의존성 없음 — next.config, 서버, 브라우저가 공통으로 쓴다.
 * - VERCEL_ENV=production 일 때만 운영. preview 신호가 하나라도 있으면 preview.
 * - Vercel 위(VERCEL=1)인데 VERCEL_ENV 가 없거나 알 수 없는 값이면 preview (fail-closed).
 * - 로컬(VERCEL 없음)과 NODE_ENV=development 의 `vercel dev` 는 운영 취급(기존 로컬 동작).
 */
export type ChatAppEnv = "production" | "preview";
export type ChatAppEnvInput = Record<string, string | undefined>;

export function resolveChatAppEnv(e: ChatAppEnvInput): ChatAppEnv {
  const build = String(e.NEXT_PUBLIC_CHAT_APP_ENV || "").trim().toLowerCase();
  const venv = String(e.VERCEL_ENV || e.NEXT_PUBLIC_VERCEL_ENV || "").trim().toLowerCase();
  const onVercel = String(e.VERCEL || "").trim() === "1";
  if (build === "preview" || venv === "preview") return "preview";
  if (venv === "production") return "production";
  if (venv === "development" && String(e.NODE_ENV || "") === "development") return "production";
  if (venv) return "preview"; // 알 수 없는 값
  if (onVercel) return "preview"; // Vercel 인데 환경값 없음
  return "production"; // 로컬·비 Vercel
}

/**
 * next.config 가 빌드 시 브라우저에 넣을 값. 같은 resolveChatAppEnv 결과를 쓰되,
 * Vercel 신호가 전혀 없는 로컬 빌드는 빈 값(브라우저가 로컬 기본 동작 유지).
 */
export function chatAppEnvBuildMarker(e: ChatAppEnvInput): "" | ChatAppEnv {
  const venv = String(e.VERCEL_ENV || "").trim();
  if (!venv && String(e.VERCEL || "").trim() !== "1") return "";
  return resolveChatAppEnv({ VERCEL_ENV: e.VERCEL_ENV, VERCEL: e.VERCEL, NODE_ENV: e.NODE_ENV });
}

/** 현재 프로세스(서버) 또는 번들(브라우저)의 환경. NEXT_PUBLIC_* 는 직접 참조해야 인라인된다. */
export function currentChatAppEnv(): ChatAppEnv {
  const p = typeof process !== "undefined" ? process.env : ({} as ChatAppEnvInput);
  return resolveChatAppEnv({
    NEXT_PUBLIC_CHAT_APP_ENV: process.env.NEXT_PUBLIC_CHAT_APP_ENV,
    NEXT_PUBLIC_VERCEL_ENV: process.env.NEXT_PUBLIC_VERCEL_ENV,
    VERCEL_ENV: p.VERCEL_ENV,
    VERCEL: p.VERCEL,
    NODE_ENV: process.env.NODE_ENV,
  });
}
