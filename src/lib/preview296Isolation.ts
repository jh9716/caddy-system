/**
 * #296 isolated Preview routing. No secrets live here (public repo).
 * Production www / Vercel production never take this path.
 */

export const PREVIEW296_BRANCH = "cursor/chat-photo-preview-first-send-1267";
export const PREVIEW296_WORKER_NAME = "verthill-chat-preview-296";
export const PREVIEW296_WORKER_ORIGIN = "https://verthill-chat-preview-296.19970106s.workers.dev";
export const PREVIEW296_WORKER_WS = "wss://verthill-chat-preview-296.19970106s.workers.dev";
export const PREVIEW296_R2_BUCKET = "verthill-chat-media-preview-296";

/** Production Neon endpoint from the last known production connection host. */
export const PRODUCTION_NEON_HOST_MARKERS = ["ep-crimson-cell-a1i1tpce"] as const;
export const PRODUCTION_CHAT_WORKER_MARKERS = [
  "verthill-chat.19970106s.workers.dev",
] as const;
export const PRODUCTION_CHAT_R2_BUCKET = "verthill-chat-media";

export function isProductionWebHost(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  return h === "www.verthill.kr" || h === "verthill.kr";
}

export function isPreview296GitRef(ref: string | undefined | null): boolean {
  return String(ref || "").trim() === PREVIEW296_BRANCH;
}

export function isPreview296VercelBuild(): boolean {
  if (String(process.env.VERCEL_ENV || "").trim() === "production") return false;
  if (String(process.env.VERCEL_ENV || "").trim() !== "preview") return false;
  return isPreview296GitRef(process.env.VERCEL_GIT_COMMIT_REF);
}

export function isPreview296BrowserHost(host: string): boolean {
  const h = String(host || "").trim().toLowerCase();
  if (!h || isProductionWebHost(h)) return false;
  if (!h.endsWith(".vercel.app")) return false;
  return h.includes("caddy-system-gt8t");
}

/** Client + server: #296 Preview traffic only. Production host always false. */
export function usePreview296Isolation(): boolean {
  if (typeof window !== "undefined") {
    return isPreview296BrowserHost(window.location.hostname);
  }
  return isPreview296VercelBuild();
}

export function preview296ChatWsBaseUrl(): string {
  return PREVIEW296_WORKER_WS;
}

export function isForbiddenProductionDatabaseHost(url: string | undefined | null): boolean {
  if (!url) return false;
  let host = "";
  try {
    host = new URL(url).hostname.toLowerCase();
  } catch {
    return true;
  }
  if (PRODUCTION_NEON_HOST_MARKERS.some((m) => host.includes(m))) return true;
  const prod = process.env.PRODUCTION_DATABASE_URL;
  return Boolean(prod && prod === url);
}

export function isForbiddenProductionChatWorkerUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const raw = String(url).toLowerCase();
  return PRODUCTION_CHAT_WORKER_MARKERS.some((m) => raw.includes(m));
}

export function assertIsolatedPreview296DatabaseUrl(url: string | undefined | null): string {
  if (!url) {
    throw new Error("preview296 DATABASE_URL 이 없습니다.");
  }
  if (isForbiddenProductionDatabaseHost(url)) {
    throw new Error("⛔ preview296 이 production Neon host 를 사용합니다. 중단.");
  }
  return url;
}

export function isForbiddenProductionPushDispatchUrl(url: string | undefined | null): boolean {
  if (!url) return false;
  const raw = String(url).trim().toLowerCase();
  if (!raw) return false;
  if (raw.includes("www.verthill.kr") || raw.includes("://verthill.kr")) return true;
  return isForbiddenProductionChatWorkerUrl(raw);
}

/** Fail-closed boot for this branch Preview only. Production Vercel never calls this. */
export function assertIsolatedPreview296RuntimeEnv(env: NodeJS.ProcessEnv = process.env): void {
  assertIsolatedPreview296DatabaseUrl(env.DATABASE_URL);
  const worker = String(env.CHAT_WORKER_URL || "").trim();
  const ws = String(env.NEXT_PUBLIC_CHAT_WS_URL || "").trim();
  if (isForbiddenProductionChatWorkerUrl(worker) || isForbiddenProductionChatWorkerUrl(ws)) {
    throw new Error("⛔ preview296 이 production Chat Worker 를 사용합니다. 중단.");
  }
  if (isForbiddenProductionPushDispatchUrl(env.CHAT_PUSH_DISPATCH_URL)) {
    throw new Error("⛔ preview296 이 production CHAT_PUSH_DISPATCH_URL 을 사용합니다. 중단.");
  }
}
