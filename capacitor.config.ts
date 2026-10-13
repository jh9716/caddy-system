import type { CapacitorConfig } from "@capacitor/cli";

/**
 * VERTHILL Native App V1 — Phase 1 Android Capacitor PoC.
 *
 * This remote-URL WebView is POC ONLY. It does not freeze the store-release
 * architecture. Do not treat `server.url` as a production App Store decision.
 *
 * - Loads the existing Next.js site. No static export.
 * - Does not duplicate API/backend.
 * - iOS / APNs / Camera remain out of scope.
 * - Android FCM foundation is additive. google-services.json is gitignored.
 * - REST Kakao OAuth inside this WebView is terminated (Samsung Internet dump).
 *   Do not add Kakao hosts to allowNavigation. Native Kakao SDK login
 *   (KakaoNativeAuthPlugin → POST /api/auth/kakao/native-session) does not
 *   use WebView navigation.
 * - App Kakao login: Android SDK + POST /api/auth/kakao/native-session.
 *   Web/PWA keep REST /api/auth/kakao/start.
 */
const config: CapacitorConfig = {
  appId: "kr.verthill.caddy",
  appName: "VERTHILL",
  webDir: "native/www",
  android: {
    allowMixedContent: false,
  },
  plugins: {
    PushNotifications: {
      presentationOptions: ["badge", "sound", "alert"],
    },
  },
  server: {
    // PoC-only: Android debug shell opens the live website.
    url: "https://www.verthill.kr",
    cleartext: false,
    androidScheme: "https",
    // Exact first-party hosts only. No Kakao WebView OAuth hosts.
    // Native Kakao SDK login does not need allowNavigation.
    allowNavigation: [
      "www.verthill.kr",
      "verthill.kr",
    ],
  },
};

export default config;
