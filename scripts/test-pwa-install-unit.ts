/**
 * VERTHILL PWA Install V1
 * 실행: npm run test:pwa-install-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  PWA_APPLE_TOUCH_ICON,
  PWA_BACKGROUND_COLOR,
  PWA_DISPLAY,
  PWA_ICON_192,
  PWA_ICON_192_MASKABLE,
  PWA_ICON_512,
  PWA_ICON_512_MASKABLE,
  PWA_NAME,
  PWA_SCOPE,
  PWA_SHORT_NAME,
  PWA_START_URL,
  PWA_SW_URL,
  PWA_THEME_COLOR,
} from "../src/lib/pwaManifest";
import {
  isIosDevice,
  isStandaloneDisplay,
  resolvePwaInstallSurface,
  shouldRegisterServiceWorker,
  PWA_INSTALL_ANDROID_BODY,
  PWA_INSTALL_BUTTON,
  PWA_INSTALL_IOS_BODY,
  PWA_INSTALL_STANDALONE_LABEL,
  PWA_INSTALL_TITLE,
} from "../src/lib/pwaInstall";
import manifest from "../src/app/manifest";
import { SESSION_MAX_AGE_SEC } from "../src/lib/sessionCookies";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (cond) {
    passed++;
    console.log("  ✓", msg);
  } else {
    failed++;
    console.error("  ✗", msg);
  }
}

function section(title: string) {
  console.log("\n==", title, "==");
}

function readSrc(rel: string) {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf8");
}

function pngSize(rel: string) {
  const buf = fs.readFileSync(path.join(process.cwd(), rel));
  const isPng = buf[0] === 0x89 && buf.toString("ascii", 1, 4) === "PNG";
  const width = buf.readUInt32BE(16);
  const height = buf.readUInt32BE(20);
  return { isPng, width, height, bytes: buf.length };
}

section("manifest required fields");
const m = manifest();
assert(m.name === "VERTHILL", "name VERTHILL");
assert(m.short_name === "VERTHILL", "short_name VERTHILL");
assert(m.start_url === "/caddy", "start_url /caddy");
assert(m.display === "standalone", "display standalone");
assert(m.scope === "/", "scope / (not /manage-only)");
assert(m.background_color === PWA_BACKGROUND_COLOR, "background_color");
assert(m.theme_color === PWA_THEME_COLOR, "theme_color");
assert(m.start_url !== "/manage", "start_url is not /manage");
assert(PWA_START_URL === "/caddy", "constant start_url /caddy");
assert(PWA_DISPLAY === "standalone", "constant display standalone");
assert(PWA_NAME === "VERTHILL" && PWA_SHORT_NAME === "VERTHILL", "name constants");
assert(PWA_SCOPE === "/", "constant scope /");
assert(!("orientation" in m) || m.orientation == null, "orientation not forced");

section("manifest icons 192/512 + apple-touch + maskable");
const icons = m.icons ?? [];
assert(
  icons.some((i) => i.src === PWA_ICON_192 && i.sizes === "192x192" && i.purpose === "any"),
  "icon 192 any"
);
assert(
  icons.some((i) => i.src === PWA_ICON_512 && i.sizes === "512x512" && i.purpose === "any"),
  "icon 512 any"
);
assert(
  icons.some(
    (i) => i.src === PWA_ICON_192_MASKABLE && i.sizes === "192x192" && i.purpose === "maskable"
  ),
  "icon 192 maskable"
);
assert(
  icons.some(
    (i) => i.src === PWA_ICON_512_MASKABLE && i.sizes === "512x512" && i.purpose === "maskable"
  ),
  "icon 512 maskable"
);
assert(
  icons.some((i) => i.src === PWA_APPLE_TOUCH_ICON && i.sizes === "180x180"),
  "apple-touch 180"
);
assert(
  icons.every((i) => i.src.startsWith("/icons/") && i.src.endsWith(".png")),
  "icons are in-repo /icons/*.png"
);
assert(
  icons.every((i) => !i.src.startsWith("http")),
  "no external image URLs"
);

section("icon files on disk");
const files: Array<[string, number]> = [
  ["public/icons/icon-192.png", 192],
  ["public/icons/icon-512.png", 512],
  ["public/icons/icon-192-maskable.png", 192],
  ["public/icons/icon-512-maskable.png", 512],
  ["public/icons/apple-touch-icon.png", 180],
  ["src/app/icon.png", 192],
];
for (const [rel, size] of files) {
  const info = pngSize(rel);
  assert(info.isPng, `${rel} is PNG`);
  assert(info.width === size && info.height === size, `${rel} is ${size}x${size}`);
  assert(info.bytes > 400, `${rel} is not empty`);
}
const favIco = fs.readFileSync(path.join(process.cwd(), "src/app/favicon.ico"));
assert(favIco.readUInt16LE(2) === 1, "src/app/favicon.ico is ICO");
assert(favIco.readUInt16LE(4) === 1, "one ICO image");
assert(favIco[6] === 32 && favIco[7] === 32, "favicon 32x32");
assert(fs.existsSync(path.join(process.cwd(), "public/favicon.ico")), "public/favicon.ico exists");

section("root metadata");
const layout = readSrc("src/app/layout.tsx");
assert(layout.includes("export const metadata"), "layout exports metadata");
assert(layout.includes("applicationName"), "applicationName");
assert(layout.includes("manifest:"), "manifest field");
assert(layout.includes("/manifest.webmanifest"), "manifest.webmanifest");
assert(layout.includes("appleWebApp"), "appleWebApp");
assert(layout.includes("apple-mobile-web-app-capable"), "iOS apple-mobile-web-app-capable");
assert(layout.includes("template:"), "title template");
assert(layout.includes("export const viewport"), "viewport export (Next themeColor)");
assert(layout.includes("themeColor"), "themeColor on viewport");
assert(layout.includes("ServiceWorkerRegister"), "SW register in root layout");
assert(!layout.includes("next.svg"), "layout does not use Next default favicon svg");
assert(!layout.includes("vercel.svg"), "layout does not use vercel.svg");

section("service worker cache policy");
const sw = readSrc("public/sw.js");
assert(sw.includes('addEventListener("install"'), "install listener");
assert(sw.includes("skipWaiting"), "skipWaiting");
assert(sw.includes('addEventListener("activate"'), "activate listener");
assert(sw.includes("clients.claim"), "clientsClaim");
assert(sw.includes('addEventListener("fetch"'), "fetch listener for installability");
assert(!/event\.respondWith/.test(sw), "fetch does not respondWith");
assert(!/\.put\(/.test(sw), "no cache.put");
assert(!/caches\.open/.test(sw), "no caches.open");
assert(!/caches\.match/.test(sw), "no caches.match");
assert(!/caches\.keys/.test(sw), "activate does not enumerate origin caches");
assert(!/caches\.delete/.test(sw), "activate does not delete origin caches");
assert(!/keys\.map/.test(sw), "no keys.map cache wipe");
assert(!/addEventListener\(\s*["']push["']/.test(sw), "no push listener in V1");
assert(
  !/addEventListener\(\s*["']notificationclick["']/.test(sw),
  "no notificationclick listener"
);
assert(!sw.includes("/api"), "SW does not special-case or cache /api");
assert(PWA_SW_URL === "/sw.js", "SW url /sw.js");

const nextConfig = readSrc("next.config.ts");
assert(nextConfig.includes("source: '/sw.js'"), "next headers for /sw.js");
assert(nextConfig.includes("Service-Worker-Allowed"), "Service-Worker-Allowed /");
assert(nextConfig.includes("no-store"), "sw.js no-store");

section("SW registration fail-soft / HTTPS");
assert(
  shouldRegisterServiceWorker({ hasServiceWorker: true, isSecureContext: true }) === true,
  "register on secure + SW"
);
assert(
  shouldRegisterServiceWorker({ hasServiceWorker: true, isSecureContext: false }) === false,
  "skip insecure HTTP"
);
assert(
  shouldRegisterServiceWorker({ hasServiceWorker: false, isSecureContext: true }) === false,
  "skip without serviceWorker API"
);
const registerSrc = readSrc("src/lib/registerServiceWorker.ts");
assert(registerSrc.includes("catch"), "registration errors are caught");
assert(!registerSrc.includes("console.log"), "no console.log in register helper");
assert(!registerSrc.includes("console.error"), "no console.error in register helper");
assert(!registerSrc.includes("json()"), "does not print API JSON");

section("Android / iOS / standalone install UI");
assert(resolvePwaInstallSurface({ standalone: true, ios: true, hasBeforeInstallPrompt: true }) === "standalone", "standalone wins over iOS");
assert(resolvePwaInstallSurface({ standalone: true, ios: false, hasBeforeInstallPrompt: true }) === "standalone", "standalone wins over Android prompt");
assert(resolvePwaInstallSurface({ standalone: false, ios: true, hasBeforeInstallPrompt: false }) === "ios-hint", "iOS hint");
assert(resolvePwaInstallSurface({ standalone: false, ios: true, hasBeforeInstallPrompt: true }) === "ios-hint", "iOS ignores BIP");
assert(resolvePwaInstallSurface({ standalone: false, ios: false, hasBeforeInstallPrompt: true }) === "android-prompt", "Android prompt");
assert(resolvePwaInstallSurface({ standalone: false, ios: false, hasBeforeInstallPrompt: false }) === "hidden", "hidden without BIP");
assert(isStandaloneDisplay({ displayModeStandalone: true, iosNavigatorStandalone: false }), "display-mode standalone");
assert(isStandaloneDisplay({ displayModeStandalone: false, iosNavigatorStandalone: true }), "iOS navigator.standalone");
assert(!isStandaloneDisplay({ displayModeStandalone: false, iosNavigatorStandalone: false }), "browser is not standalone");
assert(isIosDevice("Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X)"), "iPhone UA");
assert(isIosDevice("Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X)"), "iPad UA");
assert(!isIosDevice("Mozilla/5.0 (Linux; Android 14; Pixel) Chrome/120.0.0.0"), "Android UA not iOS");

const card = readSrc("src/components/PwaInstallCard.tsx");
assert(card.includes("beforeinstallprompt"), "listens for beforeinstallprompt");
assert(card.includes("preventDefault"), "prevents auto mini-infobar prompt");
assert(card.includes("deferred.prompt"), "prompt() only after storing event");
assert(/onClick/.test(card) && card.includes("onInstallClick"), "prompt on button click");
assert(!card.includes("Notification"), "no Notification API");
assert(!card.includes("requestPermission"), "no permission request");
assert(!card.includes("PushManager"), "no PushManager");
assert(!card.includes("showModal") && !card.includes("<dialog"), "no install modal");
assert(card.includes(PWA_INSTALL_TITLE) || card.includes("PWA_INSTALL_TITLE"), "install title");
assert(card.includes("PWA_INSTALL_IOS_BODY"), "iOS copy");
assert(card.includes("PWA_INSTALL_STANDALONE_LABEL"), "standalone copy");
assert(PWA_INSTALL_BUTTON === "앱 설치", "button copy");
assert(PWA_INSTALL_ANDROID_BODY.includes("홈 화면"), "android body");
assert(PWA_INSTALL_IOS_BODY.includes("홈 화면에 추가"), "ios body");
assert(PWA_INSTALL_STANDALONE_LABEL === "앱으로 사용 중", "standalone label");

const caddyPage = readSrc("src/app/caddy/page.tsx");
assert(caddyPage.includes("PwaInstallCard"), "/caddy renders install card");
assert(!caddyPage.includes("beforeinstallprompt"), "/caddy does not auto-prompt itself");

section("auth / API cache forbidden + no push/schema");
const pwaFiles = [
  "public/sw.js",
  "src/lib/pwaInstall.ts",
  "src/lib/pwaManifest.ts",
  "src/lib/registerServiceWorker.ts",
  "src/components/PwaInstallCard.tsx",
  "src/components/ServiceWorkerRegister.tsx",
  "src/app/manifest.ts",
  "src/app/layout.tsx",
];
for (const rel of pwaFiles) {
  const src = readSrc(rel);
  assert(!src.includes("PushSubscription"), `${rel} no PushSubscription`);
  assert(!src.includes("requestPermission"), `${rel} no notification permission`);
  assert(!src.includes("web-push"), `${rel} no web-push`);
  assert(!src.includes("vapid"), `${rel} no vapid`);
}

const caddyPagePush = readSrc("src/app/caddy/page.tsx");
assert(caddyPagePush.includes("PushNotificationCard"), "/caddy renders notification card");
assert(!caddyPagePush.includes("requestPermission"), "/caddy page does not request permission itself");

const schema = readSrc("prisma/schema.prisma");
assert(!schema.includes("model Comment"), "schema has no Comment (out of scope)");
assert(!schema.includes("model Chat"), "schema has no Chat (out of scope)");

const migrations = fs.readdirSync(path.join(process.cwd(), "prisma/migrations"));
assert(
  !migrations.some((name) => /pwa.?install/i.test(name)),
  "no PWA install migration folder"
);

assert(SESSION_MAX_AGE_SEC === 60 * 60 * 8, "session TTL still 8h");

const alimtalkPage = readSrc("src/app/manage/alimtalk/page.tsx");
assert(alimtalkPage.includes("ALIMTALK_STALE_TITLE") || alimtalkPage.includes("stale"), "alimtalk page still present");
assert(!alimtalkPage.includes("PwaInstall"), "alimtalk page not coupled to PWA UI");
assert(!alimtalkPage.includes("serviceWorker"), "alimtalk page does not register SW");

const freshness = readSrc("src/lib/alimtalkPublishedFreshness.ts");
assert(freshness.includes("assertAlimtalkCanSend"), "stale guard helper unchanged in API");

section("existing routes still present");
for (const rel of [
  "src/app/caddy/page.tsx",
  "src/app/board/page.tsx",
  "src/app/notice/page.tsx",
  "src/app/manage/page.tsx",
  "src/app/manage/assignments/page.tsx",
  "src/app/manage/alimtalk/page.tsx",
]) {
  assert(fs.existsSync(path.join(process.cwd(), rel)), `${rel} exists`);
}

section("non-PWA web remains usable");
assert(caddyPage.includes("/board"), "/caddy still links to board");
assert(caddyPage.includes("/notice"), "/caddy still links to notice");
assert(!caddyPage.includes("must install"), "install is not required copy");
const header = readSrc("src/components/AppHeader.tsx");
assert(header.includes("LogoutButton"), "logout still in header");
assert(header.includes("/manage"), "admin manage nav still present");

if (failed > 0) {
  console.error(`\nPWA install tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nPWA install tests passed: ${passed}`);
