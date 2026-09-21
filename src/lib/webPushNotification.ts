/**
 * Service-worker push payload + same-origin click URL helpers.
 * Pure functions for unit tests; public/sw.js keeps a vanilla copy.
 */

export const DEFAULT_PUSH_TITLE = "VERTHILL";
export const DEFAULT_PUSH_URL = "/caddy";
export const PWA_NOTIFICATION_ICON = "/icons/icon-192.png";
export const PWA_NOTIFICATION_BADGE = "/icons/badge-96.png";

export type ParsedPushPayload = {
  title: string;
  body: string;
  url: string;
  tag?: string;
};

export function parsePushPayload(rawText: unknown): ParsedPushPayload | null {
  try {
    const data = JSON.parse(String(rawText ?? ""));
    if (!data || typeof data !== "object") return null;
    const rec = data as Record<string, unknown>;
    const title =
      typeof rec.title === "string" && rec.title.trim()
        ? rec.title.trim()
        : DEFAULT_PUSH_TITLE;
    const body = typeof rec.body === "string" ? rec.body : "";
    const url =
      typeof rec.url === "string" && rec.url.trim() ? rec.url.trim() : DEFAULT_PUSH_URL;
    const tag =
      typeof rec.tag === "string" && rec.tag.trim() ? rec.tag.trim() : undefined;
    return { title, body, url, tag };
  } catch {
    return null;
  }
}

/** Same-origin absolute URL, or null if external / unsafe. */
export function resolveSameOriginUrl(rawUrl: unknown, origin: string): string | null {
  try {
    const base = String(origin || "").replace(/\/$/, "");
    if (!base) return null;
    const raw = String(rawUrl || "").trim() || DEFAULT_PUSH_URL;
    if (raw.startsWith("//") || /^javascript:/i.test(raw) || /^data:/i.test(raw)) {
      return null;
    }
    if (raw.startsWith("/")) return base + raw;
    const abs = new URL(raw);
    if (abs.origin !== base) return null;
    return abs.href;
  } catch {
    return null;
  }
}
