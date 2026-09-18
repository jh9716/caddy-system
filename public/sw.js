/* VERTHILL PWA + Web Push display V1
 *
 * Minimal worker for home-screen installability and system notification display.
 * This is NOT an offline-first app.
 *
 * Cache policy:
 * - Do not store HTML, API, auth, login, manage, or published board.
 * - Do not write into Cache Storage.
 * - Do not enumerate or delete origin Cache Storage on activate.
 *   V1 creates no caches; a later PR may clean only a VERTHILL prefix.
 * - A fetch listener is present so Chromium can treat the app as installable.
 *   The handler is a no-op: the browser keeps the default network path.
 *
 * Push:
 * - Listen for push and notificationclick only.
 * - Same-origin URLs only. Invalid JSON fails closed (no throw).
 */
/* eslint-disable no-restricted-globals */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(self.clients.claim());
});

self.addEventListener("fetch", () => {
  // Network-only. No interception.
});

function parsePushPayload(rawText) {
  try {
    const data = JSON.parse(rawText);
    if (!data || typeof data !== "object") return null;
    const title =
      typeof data.title === "string" && data.title.trim()
        ? data.title.trim()
        : "VERTHILL";
    const body = typeof data.body === "string" ? data.body : "";
    const url = typeof data.url === "string" && data.url.trim() ? data.url.trim() : "/caddy";
    const tag = typeof data.tag === "string" && data.tag.trim() ? data.tag.trim() : undefined;
    return { title, body, url, tag };
  } catch {
    return null;
  }
}

function resolveSameOriginUrl(rawUrl, origin) {
  try {
    const base = String(origin || "").replace(/\/$/, "");
    if (!base) return null;
    const raw = String(rawUrl || "").trim() || "/caddy";
    if (raw.startsWith("//") || /^javascript:/i.test(raw) || /^data:/i.test(raw)) {
      return null;
    }
    if (raw.startsWith("/")) {
      return base + raw;
    }
    const abs = new URL(raw);
    if (abs.origin !== base) return null;
    return abs.href;
  } catch {
    return null;
  }
}

self.addEventListener("push", (event) => {
  event.waitUntil(
    (async () => {
      let parsed = null;
      try {
        if (!event.data) {
          parsed = { title: "VERTHILL", body: "", url: "/caddy" };
        } else {
          parsed = parsePushPayload(event.data.text());
        }
      } catch {
        return;
      }
      if (!parsed) return;
      const origin = self.location.origin;
      const url = resolveSameOriginUrl(parsed.url, origin) || origin + "/caddy";
      const options = {
        body: parsed.body,
        icon: "/icons/icon-192.png",
        badge: "/icons/icon-192.png",
        data: { url },
      };
      if (parsed.tag) options.tag = parsed.tag;
      await self.registration.showNotification(parsed.title, options);
    })()
  );
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const origin = self.location.origin;
  const raw =
    event.notification && event.notification.data && event.notification.data.url;
  const url = resolveSameOriginUrl(raw, origin);
  if (!url) return;
  event.waitUntil(
    (async () => {
      const list = await self.clients.matchAll({
        type: "window",
        includeUncontrolled: true,
      });
      for (const client of list) {
        let same = false;
        try {
          same = new URL(client.url).origin === origin;
        } catch {
          same = false;
        }
        if (!same) continue;
        if (typeof client.focus === "function") await client.focus();
        if (typeof client.navigate === "function") await client.navigate(url);
        return;
      }
      if (self.clients.openWindow) await self.clients.openWindow(url);
    })()
  );
});
