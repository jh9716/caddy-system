import type { CapacitorConfig } from "@capacitor/cli";

/**
 * VERTHILL Native App V1 — Phase 1 Android Capacitor PoC.
 *
 * This remote-URL WebView is POC ONLY. It does not freeze the store-release
 * architecture. Do not treat `server.url` as a production App Store decision.
 *
 * - Loads the existing Next.js site. No static export.
 * - Does not duplicate API/backend.
 * - iOS / FCM / APNs / Camera / Kakao SDK remain out of scope.
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
    // Keep REST Kakao OAuth in this WebView. Capacitor otherwise
    // ACTION_VIEW-launches unknown hosts (Samsung Internet), which splits
    // kakao_oauth_state from callback. Exact hosts only, no kakao.com wildcards.
    //
    // Navigation (user-visible):
    //   www.verthill.kr / verthill.kr  app + /api/auth/kakao/callback
    //   kauth.kakao.com                official /oauth/authorize + consent
    //   accounts.kakao.com             Kakao Account login page after authorize
    // Server-only (not WebView navigation): /oauth/token POST and /v2/user/me.
    allowNavigation: [
      "www.verthill.kr",
      "verthill.kr",
      "kauth.kakao.com",
      "accounts.kakao.com",
    ],
  },
};

export default config;
