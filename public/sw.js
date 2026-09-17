/* VERTHILL PWA Install V1
 *
 * Minimal worker for home-screen installability.
 * This is NOT an offline-first app.
 *
 * Cache policy:
 * - Do not store HTML, API, auth, login, manage, or published board.
 * - Do not write into Cache Storage.
 * - A fetch listener is present so Chromium can treat the app as installable.
 *   The handler is a no-op: the browser keeps the default network path.
 *
 * Push:
 * - V1 does not listen for push or notification clicks.
 * - A later PR may attach those listeners after explicit product approval.
 */
/* eslint-disable no-restricted-globals */

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.map((key) => caches.delete(key)));
      await self.clients.claim();
    })()
  );
});

self.addEventListener("fetch", () => {
  // Network-only. No interception.
});
