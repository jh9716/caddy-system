/**
 * VERTHILL Native App V1 Phase 1 — Android Capacitor PoC guards.
 * No network. No production login. No Android SDK required.
 *
 * 실행: npm run test:native-android-poc-unit
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  formatNativeKakaoBridgeError,
  isSafeNativeKakaoDiagnostic,
} from "../src/lib/kakaoNativeBridge";

let passed = 0;
let failed = 0;

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function exists(rel: string): boolean {
  return fs.existsSync(path.resolve(rel));
}

function gitTracked(rel: string): boolean {
  const out = execSync(`git ls-files -- "${rel}"`, { encoding: "utf8" }).trim();
  return out.length > 0;
}

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

const cfg = read("capacitor.config.ts");
const pkg = read("package.json");
const nextCfg = read("next.config.ts");
const login = read("src/app/api/login/route.ts");
const authLogin = read("src/app/api/auth/login/route.ts");
const passwordLogin = read("src/lib/passwordLogin.ts");
const loginClient = read("src/app/login/LoginClient.tsx");
const kakaoStart = read("src/app/api/auth/kakao/start/route.ts");
const kakaoCallback = read("src/app/api/auth/kakao/callback/route.ts");
const kakaoOAuth = read("src/lib/kakaoOAuth.ts");
const roleRouting = read("src/lib/roleRouting.ts");
const photoForm = read("src/app/course-reports/CourseReportForm.tsx");
const pwaManifest = read("src/lib/pwaManifest.ts");
const schema = read("prisma/schema.prisma");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const strings = read("android/app/src/main/res/values/strings.xml");
const colors = read("android/app/src/main/res/values/colors.xml");
const launcherBg = read(
  "android/app/src/main/res/values/ic_launcher_background.xml"
);
const mainActivity = read(
  "android/app/src/main/java/kr/verthill/caddy/MainActivity.java"
);
const filePaths = read("android/app/src/main/res/xml/file_paths.xml");
const appGradle = read("android/app/build.gradle");

console.log("== Capacitor PoC config ==");
assert(cfg.includes('appId: "kr.verthill.caddy"'), "appId kr.verthill.caddy");
assert(cfg.includes('appName: "VERTHILL"'), "appName VERTHILL");
assert(
  cfg.includes('url: "https://www.verthill.kr"'),
  "PoC remote URL is www.verthill.kr"
);
assert(cfg.includes("PoC") || cfg.includes("POC"), "config marks remote URL as PoC");
assert(cfg.includes("cleartext: false"), "HTTPS only, no cleartext");
assert(cfg.includes("allowMixedContent: false"), "mixed content disabled");
assert(cfg.includes('"www.verthill.kr"'), "allowNavigation includes www.verthill.kr");
assert(cfg.includes('"verthill.kr"'), "allowNavigation includes verthill.kr");
assert(cfg.includes('"kauth.kakao.com"'), "allowNavigation includes kauth.kakao.com");
assert(
  cfg.includes('"accounts.kakao.com"'),
  "allowNavigation includes accounts.kakao.com"
);
assert(
  !cfg.includes('"*.kakao.com"') && !cfg.includes("*.kakao."),
  "no wildcard Kakao allowNavigation"
);
assert(!cfg.includes("kapi.kakao.com"), "kapi.kakao.com is not a WebView host");
assert(!exists("ios"), "iOS project is not added");

console.log("== packages stay web-safe ==");
assert(pkg.includes('"@capacitor/android"'), "capacitor android dependency");
assert(pkg.includes('"@capacitor/core"'), "capacitor core dependency");
assert(!pkg.includes("@capacitor/ios"), "no Capacitor iOS package");
assert(pkg.includes('"@capacitor/push-notifications"'), "Capacitor PushNotifications for Android FCM");
assert(!pkg.includes("@capacitor/camera"), "no Camera plugin");
assert(!/"firebase"/.test(pkg) && !pkg.includes('"firebase/'), "no Firebase JS package");
assert(!pkg.includes("@capacitor-community/fcm"), "no extra FCM community plugin");
assert(!/kakao-sdk|@kakao-sdk|react-native-kakao|com.kakao.sdk:v2/i.test(pkg), "no Kakao SDK npm package");

console.log("== web architecture unchanged ==");
assert(!nextCfg.includes("output:"), "next.config has no static export");
assert(pwaManifest.includes('PWA_START_URL = "/caddy"'), "PWA start_url frozen");
assert(schema.includes("model PushSubscription"), "Web Push model remains");
assert(schema.includes("model DevicePushToken"), "additive DevicePushToken model");
assert(schema.includes("@@unique([userId, token])"), "DevicePushToken unique(userId, token)");
assert(!schema.includes("model NativePush"), "no NativePush model");

console.log("== ID/PW login is cookie-only (no User write) ==");
assert(login.includes("passwordLogin("), "/api/login uses passwordLogin");
assert(authLogin.includes("passwordLogin("), "/api/auth/login uses passwordLogin");
assert(
  !/\bprisma\.user\.(update|create|upsert|delete)/.test(login),
  "/api/login has no User mutation"
);
assert(
  !/\bprisma\.user\.(update|create|upsert|delete)/.test(authLogin),
  "/api/auth/login has no User mutation"
);
assert(passwordLogin.includes("findUnique"), "passwordLogin reads User by username");
assert(
  !/\.update\(/.test(passwordLogin) && !/\.create\(/.test(passwordLogin),
  "passwordLogin does not write User"
);
assert(loginClient.includes('fetch("/api/login"'), "login form posts /api/login");
assert(
  roleRouting.includes('href: "/manage"') &&
    roleRouting.includes('return postLoginPath("admin", false)'),
  "admin post-login prefers /manage"
);
assert(roleRouting.includes("caddy") && roleRouting.includes("/caddy"), "caddy routing intact");

console.log("== Kakao REST kept; native SDK wired for Capacitor only ==");
assert(
  loginClient.includes("runKakaoLogin") &&
    loginClient.includes("KakaoNativeAuth.login"),
  "LoginClient native Kakao path exists"
);
assert(
  loginClient.includes("/api/auth/kakao/start") ||
    read("src/lib/kakaoNativeBridge.ts").includes("/api/auth/kakao/start"),
  "web/PWA REST start URL remains"
);
assert(
  read("src/lib/kakaoNativeBridge.ts").includes(
    "input.isNativePlatform === true"
  ),
  "native Kakao requires Capacitor native platform"
);
assert(
  kakaoStart.includes("buildKakaoRedirectUri") &&
    kakaoOAuth.includes("KAKAO_CALLBACK_PATH"),
  "Kakao redirect URI still host-derived /api/auth/kakao/callback"
);
assert(
  kakaoOAuth.includes("https://kauth.kakao.com/oauth/authorize"),
  "Kakao authorize URL unchanged"
);
assert(kakaoOAuth.includes('sameSite: "lax"'), "OAuth cookies stay SameSite=Lax");
assert(kakaoOAuth.includes("httpOnly: true"), "OAuth cookies stay httpOnly");
assert(kakaoCallback.includes("statesMatch(cookieState, queryState)"), "callback still validates state");
assert(!kakaoCallback.includes("skipState") && !kakaoOAuth.includes("skipState"), "no state bypass");
assert(
  kakaoCallback.includes("findOrCreateKakaoSessionUser"),
  "REST callback reuses shared Kakao User helper"
);
assert(
  exists("src/app/api/auth/kakao/native-session/route.ts"),
  "native-session HTTP route is mounted"
);
const nativeSession = read("src/app/api/auth/kakao/native-session/route.ts");
assert(
  nativeSession.includes("getKakaoAppIdConfig") &&
    nativeSession.includes("liveNativeKakaoFetchers") &&
    nativeSession.includes("findOrCreateKakaoSessionUser") &&
    nativeSession.includes("applySessionCookies"),
  "native-session verifies Kakao token then reuses User + vh_session"
);
assert(
  !/console\.(log|info|debug|error)\([^)]*accessToken/.test(nativeSession),
  "native-session does not log accessToken"
);
assert(
  !nativeSession.includes("localStorage") &&
    !nativeSession.includes("sessionStorage"),
  "native-session does not touch web storage"
);

console.log("== CourseReport file input remains web input ==");
assert(photoForm.includes('type="file"'), "composer still uses input[type=file]");
assert(
  !photoForm.includes("@capacitor/camera"),
  "composer does not import Camera plugin"
);

console.log("== Android shell ==");
assert(strings.includes(">VERTHILL<"), "Android app_name VERTHILL");
assert(
  appGradle.includes('applicationId "kr.verthill.caddy"'),
  "Gradle applicationId matches appId"
);
assert(
  mainActivity.includes("extends BridgeActivity"),
  "MainActivity is stock BridgeActivity"
);
assert(
  mainActivity.includes("registerPlugin(KakaoNativeAuthPlugin.class)"),
  "KakaoNativeAuth plugin registered"
);
const kakaoPlugin = read(
  "android/app/src/main/java/kr/verthill/caddy/kakao/KakaoNativeAuthPlugin.java"
);
assert(
  kakaoPlugin.includes("loginWithKakaoTalk") &&
    kakaoPlugin.includes("loginWithKakaoAccount"),
  "native Kakao plugin uses Talk then Account fallback"
);
assert(
  kakaoPlugin.includes("safeDiagnostic(\"account\"") &&
    kakaoPlugin.includes("kakao_native_") &&
    kakaoPlugin.includes("safeTokenEmptyDiagnostic") &&
    kakaoPlugin.includes("AuthError") &&
    kakaoPlugin.includes("ClientError") &&
    kakaoPlugin.includes("getReason()"),
  "plugin rejects allowlisted Kakao SDK reason names instead of collapsing to kakao_token"
);
assert(
  !kakaoPlugin.includes("getErrorDescription") &&
    !kakaoPlugin.includes("getLocalizedMessage") &&
    !kakaoPlugin.includes(".toString()") &&
    !kakaoPlugin.includes("getMessage()"),
  "plugin does not expose raw exception message or toString"
);
assert(
  !/Log\.(d|i|v|e|w)\([^)]*accessToken/.test(kakaoPlugin),
  "plugin does not log accessToken"
);
assert(
  loginClient.includes("formatNativeKakaoBridgeError"),
  "LoginClient shows native Kakao diagnostic on Play"
);
assert(manifest.includes("android.permission.INTERNET"), "INTERNET permission");
assert(
  manifest.includes("com.kakao.talk"),
  "queries includes KakaoTalk for SDK login"
);
assert(
  manifest.includes("com.kakao.sdk.auth.AuthCodeHandlerActivity") &&
    manifest.includes("${kakaoScheme}"),
  "AuthCodeHandlerActivity uses injected kakaoScheme"
);
assert(
  manifest.includes("android:name=\".VerthillApp\""),
  "custom Application inits KakaoSdk"
);
assert(
  read("android/app/src/main/java/kr/verthill/caddy/VerthillApp.java").includes(
    "KakaoSdk.init"
  ) &&
    read("android/app/src/main/java/kr/verthill/caddy/VerthillApp.java").includes(
      "setLoggingEnabled(false)"
    ),
  "VerthillApp calls KakaoSdk.init with SDK logging off"
);
assert(!manifest.includes("CAMERA"), "no CAMERA permission");
assert(
  manifest.includes("POST_NOTIFICATIONS"),
  "POST_NOTIFICATIONS for Android 13+ FCM"
);
assert(
  manifest.includes('android:usesCleartextTraffic="false"'),
  "cleartext traffic disabled"
);
assert(filePaths.includes("cache-path"), "FileProvider paths exist for file chooser");
assert(colors.includes("#163028"), "launcher/theme uses deep green");
assert(launcherBg.includes("#163028"), "adaptive icon background is deep green");
assert(
  exists("android/app/src/main/res/mipmap-xxxhdpi/ic_launcher.png"),
  "xxxhdpi launcher icon generated"
);
assert(
  exists("android/app/src/main/res/drawable/splash.png"),
  "splash drawable generated"
);
assert(
  !gitTracked("android/app/google-services.json"),
  "google-services.json is not committed"
);
assert(
  exists("android/app/google-services.json.example"),
  "google-services.json.example documents package name only"
);
assert(
  read(".gitignore").includes("android/app/google-services.json"),
  "google-services.json is gitignored"
);
assert(
  read("android/.gitignore").includes("app/google-services.json"),
  "android/.gitignore ignores app/google-services.json"
);
if (exists("android/app/google-services.json")) {
  const gs = JSON.parse(read("android/app/google-services.json")) as {
    project_info?: { project_id?: unknown; project_number?: unknown };
    client?: Array<{
      client_info?: { android_client_info?: { package_name?: unknown } };
    }>;
  };
  assert(
    Boolean(String(gs.project_info?.project_id ?? "").trim()),
    "local google-services.json has project_id"
  );
  assert(
    Boolean(String(gs.project_info?.project_number ?? "").trim()),
    "local google-services.json has project_number"
  );
  assert(
    gs.client?.[0]?.client_info?.android_client_info?.package_name ===
      "kr.verthill.caddy",
    "local google-services.json package_name is kr.verthill.caddy"
  );
}
assert(!exists("ios"), "still no ios/");
assert(exists("android/app/debug.keystore"), "PoC debug keystore exists on disk for Kakao hash stability");
assert(
  read(".gitignore").includes("android/app/debug.keystore"),
  "debug.keystore is gitignored, not tracked"
);
assert(
  read("android/.gitignore").includes("*.keystore"),
  "android/.gitignore ignores keystore files"
);
assert(
  appGradle.includes("KAKAO_NATIVE_APP_KEY") &&
    appGradle.includes("kakaoScheme") &&
    appGradle.includes("kakao_unconfigured"),
  "Gradle injects Kakao native app key / scheme without a hardcoded secret"
);
assert(
  appGradle.includes("com.kakao.sdk:v2-user") &&
    read("android/variables.gradle").includes("kakaoSdkVersion"),
  "Kakao Android SDK v2-user is a Gradle dependency"
);
assert(
  appGradle.includes("versionCode 10") && appGradle.includes('versionName "1.0.7"'),
  "Play candidate versionCode 10 / versionName 1.0.7"
);
assert(
  !appGradle.includes("length()") &&
    !/logger\.[^(]*\([^)]*kakaoNativeAppKey/.test(appGradle),
  "Gradle does not log Native App Key or its length"
);
assert(
  read(".gitignore").includes("android/kakao.properties"),
  "kakao.properties is gitignored"
);
assert(
  exists("android/kakao.properties.example"),
  "kakao.properties.example exists"
);
assert(
  read("src/lib/kakaoNativeBridge.ts").includes(
    "export const NATIVE_KAKAO_LOGIN_ENABLED = true"
  ),
  "native Kakao login flag is true"
);
assert(
  cfg.includes("REST Kakao OAuth inside this WebView is terminated") ||
    cfg.includes("Do not add more allowNavigation"),
  "allowNavigation expansion is frozen"
);

console.log("== Phase 2 native push foundation ==");
assert(
  read("src/lib/nativePlatform.ts").includes("isNativePlatform") &&
    !read("src/lib/nativePlatform.ts").includes("userAgent"),
  "native detection is official isNativePlatform, no UA"
);
assert(
  read("src/lib/nativePlatformClient.ts").includes("Capacitor.isNativePlatform()"),
  "client uses Capacitor.isNativePlatform()"
);
assert(
  exists("src/app/api/push/native-token/route.ts"),
  "native-token HTTP route is mounted"
);
assert(
  !/console\.(log|info|debug|error)\([^)]*token/.test(
    read("src/app/api/push/native-token/route.ts")
  ),
  "native-token route does not log token"
);
assert(
  read("src/app/caddy/page.tsx").includes("DevicePushSettings") &&
    read("src/app/manage/notifications/page.tsx").includes("DevicePushSettings"),
  "caddy and admin use DevicePushSettings split"
);
assert(
  read("src/components/DevicePushSettings.tsx").includes("NativePushNotificationCard"),
  "native card is separate from Web Push card"
);
assert(
  exists("prisma/migrations/20260921120000_device_push_token/migration.sql"),
  "DevicePushToken migration file exists"
);
assert(!exists("ios"), "iOS project still not added");

console.log("== native Kakao diagnostic allowlist ==");
assert(
  isSafeNativeKakaoDiagnostic("kakao_native_account: AuthError / Misconfigured") &&
    isSafeNativeKakaoDiagnostic("kakao_native_token-empty: empty / token-null") &&
    !isSafeNativeKakaoDiagnostic(
      "AuthError(statusCode=401, reason=Misconfigured, response=https://kauth.kakao.com?token=abc)"
    ) &&
    !isSafeNativeKakaoDiagnostic("kakao_token"),
  "only allowlisted native diagnostic strings are trusted"
);
assert(
  formatNativeKakaoBridgeError({
    message: "kakao_native_account: AuthError / Misconfigured",
    code: "kakao_token",
  }).includes("kakao_native_account: AuthError / Misconfigured"),
  "Login UI surfaces account AuthError reason"
);
assert(
  formatNativeKakaoBridgeError({
    message: "Bearer secret-token https://kauth.kakao.com/oauth?code=abc",
    code: "kakao_token",
  }) === "카카오 인증에 실패했습니다. 잠시 후 다시 시도해 주세요.",
  "raw token/URL exception text is not shown"
);
assert(
  formatNativeKakaoBridgeError({
    message: "사용할 수 없는 계정입니다.",
    code: "",
  }) === "사용할 수 없는 계정입니다.",
  "mapped native-session Korean errors still pass through"
);

if (failed) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
