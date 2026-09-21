import type { CapacitorConfig } from "@capacitor/cli";

/**
 * VERTHILL Native App V1 — Phase 1 Android Capacitor PoC.
 *
 * This remote-URL WebView is POC ONLY. It does not freeze the store-release
 * architecture. Do not treat `server.url` as a production App Store decision.
 *
 * - Loads the existing Next.js site. No static export.
 * - Does not duplicate API/backend.
 * - iOS / FCM / APNs / Camera / Kakao SDK are out of scope for Phase 1.
 */
const config: CapacitorConfig = {
  appId: "kr.verthill.caddy",
  appName: "VERTHILL",
  webDir: "native/www",
  android: {
    allowMixedContent: false,
  },
  server: {
    // PoC-only: Android debug shell opens the live website.
    url: "https://www.verthill.kr",
    cleartext: false,
    androidScheme: "https",
    // Same-site app hosts stay in the WebView. Unknown https hosts
    // (Kakao authorize, etc.) follow Capacitor default: system browser.
    allowNavigation: ["www.verthill.kr", "verthill.kr"],
  },
};

export default config;
