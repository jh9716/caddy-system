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

export type WebPushNotificationOptions = {
  body: string;
  icon: string;
  badge: string;
  data: { url: string };
  tag?: string;
  renotify?: true;
};

/** Collapse by tag, but alert again on each replacement. No tag → no renotify. */
export function buildWebPushNotificationOptions(input: {
  body: string;
  url: string;
  tag?: string;
}): WebPushNotificationOptions {
  const options: WebPushNotificationOptions = {
    body: input.body,
    icon: PWA_NOTIFICATION_ICON,
    badge: PWA_NOTIFICATION_BADGE,
    data: { url: input.url },
  };
  const tag = String(input.tag || "").trim();
  if (tag) {
    options.tag = tag;
    options.renotify = true;
  }
  return options;
}

/** Path + search match. Hash and extra fields must not hide a chat deep link. */
export function notificationClickUrlsEqual(left: unknown, right: unknown): boolean {
  try {
    const a = new URL(String(left || ""));
    const b = new URL(String(right || ""));
    return a.origin === b.origin && a.pathname === b.pathname && a.search === b.search;
  } catch {
    return false;
  }
}

export type NotificationClickVia = "focus" | "navigate" | "open_window" | "none";

type NotificationClickClient = {
  url: string;
  focus?: () => Promise<unknown> | unknown;
  navigate?: (
    url: string
  ) =>
    | Promise<{ focus?: () => Promise<unknown> | unknown } | null | undefined>
    | { focus?: () => Promise<unknown> | unknown }
    | null
    | undefined;
};

/**
 * Open the notification destination. Exact client → focus.
 * Other same-origin clients: navigate first, then focus the result.
 * Failed/missing navigate falls through to openWindow(destination).
 * Never focus /caddy (or any other page) and stop without changing URL.
 */
export async function openNotificationClickUrl(input: {
  destinationUrl: string | null;
  clients: readonly NotificationClickClient[];
  openWindow?: (url: string) => Promise<unknown> | unknown;
}): Promise<{ via: NotificationClickVia; url: string | null }> {
  const dest = String(input.destinationUrl || "").trim();
  if (!dest) return { via: "none", url: null };

  for (const client of input.clients) {
    if (!notificationClickUrlsEqual(client.url, dest)) continue;
    if (typeof client.focus === "function") await client.focus();
    return { via: "focus", url: dest };
  }

  for (const client of input.clients) {
    let same = false;
    try {
      same = new URL(client.url).origin === new URL(dest).origin;
    } catch {
      same = false;
    }
    if (!same || typeof client.navigate !== "function") continue;
    let next: { focus?: () => Promise<unknown> | unknown } | null | undefined;
    try {
      next = await client.navigate(dest);
    } catch {
      continue;
    }
    if (next && typeof next.focus === "function") {
      await next.focus();
      return { via: "navigate", url: dest };
    }
  }

  if (typeof input.openWindow === "function") {
    await input.openWindow(dest);
    return { via: "open_window", url: dest };
  }
  return { via: "none", url: dest };
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
