/**
 * Debug-APK Preview WebView hosts only. Release never imports this.
 * Keep in sync with android/app/src/debug/java/.../NoticeFileDownloadFlavorHosts.java.
 */
const PREVIEW_GIT_HOST_RE =
  /^caddy-system-gt8t-git-[a-z0-9-]{1,80}-jh9716s-projects\.vercel\.app$/;
const PREVIEW_DPL_HOST_RE =
  /^caddy-system-gt8t-[a-z0-9]{8,20}-jh9716s-projects\.vercel\.app$/;

export const ANDROID_DEBUG_PREVIEW_DEFAULT_URL =
  "https://caddy-system-gt8t-git-cursor-android-no-4bcddd-jh9716s-projects.vercel.app";

export const ANDROID_DEBUG_PREVIEW_PRODUCTION_HOSTS = [
  "www.verthill.kr",
  "verthill.kr",
] as const;

/** Vercel Authentication SSO hosts for Debug WebView only. Not download hosts. */
export const ANDROID_DEBUG_PREVIEW_AUTH_HOSTS = ["vercel.com"] as const;

export function androidDebugPreviewHostFromUrl(raw: string): string | null {
  const value = String(raw ?? "").trim();
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "https:") return null;
  if (url.username || url.password) return null;
  if (url.port && url.port !== "443") return null;
  if (url.pathname !== "/" && url.pathname !== "") return null;
  if (url.search || url.hash) return null;
  const host = url.hostname.toLowerCase();
  if (!isAndroidDebugPreviewHost(host)) return null;
  return host;
}

export function isAndroidDebugPreviewHost(host: string): boolean {
  const normalized = String(host ?? "").trim().toLowerCase();
  if (!normalized) return false;
  if ((ANDROID_DEBUG_PREVIEW_PRODUCTION_HOSTS as readonly string[]).includes(normalized)) {
    return false;
  }
  if (normalized === "caddy-system-gt8t.vercel.app") return false;
  if (normalized === "caddy-system-gt8t-jh9716s-projects.vercel.app") return false;
  if (normalized === "caddy-system-gt8t-git-main-jh9716s-projects.vercel.app") return false;
  return PREVIEW_GIT_HOST_RE.test(normalized) || PREVIEW_DPL_HOST_RE.test(normalized);
}
