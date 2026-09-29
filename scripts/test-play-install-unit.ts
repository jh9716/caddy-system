/**
 * VERTHILL Play closed-test install modal
 * 실행: npm run test:play-install-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  GOOGLE_PLAY_TEST_URL_ENV,
  PLAY_INSTALL_CLOSE,
  PLAY_INSTALL_CTA_LABEL,
  PLAY_INSTALL_MISSING_URL,
  PLAY_INSTALL_STEPS,
  PLAY_INSTALL_TITLE,
  PLAY_INSTALL_WEBAPP_LABEL,
  googlePlayTestUrlFromEnv,
  readGooglePlayTestUrl,
  resolveHomeInstallPrimary,
  shouldOfferWebAppInstall,
} from "../src/lib/playInstall";
import { PWA_INSTALL_CTA_LABEL } from "../src/lib/pwaInstall";

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

section("copy");
assert(PLAY_INSTALL_TITLE === "VERTHILL 앱 설치", "modal title");
assert(PLAY_INSTALL_TITLE === PWA_INSTALL_CTA_LABEL, "title matches home button");
assert(PLAY_INSTALL_CTA_LABEL === "Google Play에서 설치", "Play CTA label");
assert(PLAY_INSTALL_WEBAPP_LABEL === "웹앱으로 사용하기", "web-app secondary label");
assert(PLAY_INSTALL_CLOSE === "닫기", "close label");
assert(
  PLAY_INSTALL_MISSING_URL ===
    "Google Play 테스트 설치 링크가 아직 설정되지 않았습니다. 관리자에게 문의해주세요.",
  "missing URL message"
);
assert(PLAY_INSTALL_STEPS.length === 3, "three Android steps");
assert(
  PLAY_INSTALL_STEPS[0].includes("비공개 테스트") &&
    PLAY_INSTALL_STEPS[0].includes("Google 계정"),
  "step 1 testers account"
);
assert(
  PLAY_INSTALL_STEPS[1].includes("Google Play에서 설치"),
  "step 2 mentions Play CTA"
);
assert(
  PLAY_INSTALL_STEPS[2].includes("테스트 참여") &&
    PLAY_INSTALL_STEPS[2].includes("VERTHILL"),
  "step 3 join then install"
);

section("Play URL from env");
assert(GOOGLE_PLAY_TEST_URL_ENV === "NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL", "env name");
assert(readGooglePlayTestUrl(undefined) === null, "undefined → null");
assert(readGooglePlayTestUrl(null) === null, "null → null");
assert(readGooglePlayTestUrl("") === null, "empty → null");
assert(readGooglePlayTestUrl("   ") === null, "whitespace → null");
assert(readGooglePlayTestUrl("not-a-url") === null, "invalid → null");
assert(readGooglePlayTestUrl("javascript:alert(1)") === null, "javascript rejected");
assert(readGooglePlayTestUrl("data:text/html,hi") === null, "data URL rejected");
assert(
  readGooglePlayTestUrl("https://play.google.com/apps/testing/kr.verthill.caddy") ===
    "https://play.google.com/apps/testing/kr.verthill.caddy",
  "https Play URL kept as-is"
);
assert(
  readGooglePlayTestUrl("  https://play.google.com/store/apps/details?id=kr.verthill.caddy  ") ===
    "https://play.google.com/store/apps/details?id=kr.verthill.caddy",
  "trims surrounding whitespace"
);
assert(googlePlayTestUrlFromEnv(undefined) === null, "missing env value → null");
assert(googlePlayTestUrlFromEnv("") === null, "empty env value → null");
assert(
  googlePlayTestUrlFromEnv("https://play.google.com/apps/testing/kr.verthill.caddy") ===
    "https://play.google.com/apps/testing/kr.verthill.caddy",
  "env helper returns configured URL"
);
assert(shouldOfferWebAppInstall("prompt") === true, "BIP still offers web-app");
assert(shouldOfferWebAppInstall("sheet") === true, "hint sheet still offers web-app");
assert(shouldOfferWebAppInstall("hide") === false, "unsupported surface hides web-app");
assert(
  resolveHomeInstallPrimary("android-prompt") === "play",
  "Android BIP → Play modal"
);
assert(
  resolveHomeInstallPrimary("android-hint") === "play",
  "Android hint → Play modal"
);
assert(
  resolveHomeInstallPrimary("samsung-hint") === "play",
  "Samsung → Play modal"
);
assert(
  resolveHomeInstallPrimary("ios-hint") === "pwa-sheet",
  "iOS → PWA sheet, skip Play"
);
assert(resolveHomeInstallPrimary("hidden") === "hide", "desktop stays hide");
assert(resolveHomeInstallPrimary("standalone") === "hide", "installed PWA stays hide");

section("home CTA + modal wiring");
const home = readSrc("src/app/page.tsx");
const homeCta = readSrc("src/components/PwaInstallHomeCta.tsx");
const playSheet = readSrc("src/components/PlayInstallSheet.tsx");
const playLib = readSrc("src/lib/playInstall.ts");
const pwaSheet = readSrc("src/components/PwaInstallHintSheet.tsx");
const loginClient = readSrc("src/app/login/LoginClient.tsx");
const caddyPage = readSrc("src/app/caddy/page.tsx");

assert(home.includes("PwaInstallHomeCta"), "home still renders install CTA");
assert(homeCta.includes("PWA_INSTALL_CTA_LABEL"), "home button label unchanged");
assert(homeCta.includes("resolveHomeInstallPrimary"), "home branches Android/iOS");
assert(homeCta.includes("PlayInstallSheet"), "Android home can open Play modal");
assert(homeCta.includes('primary === "play"'), "Android click opens Play modal");
assert(homeCta.includes('primary === "pwa-sheet"'), "iOS click opens PWA sheet");
assert(!playLib.includes("kr.verthill.app"), "no stale kr.verthill.app package");
assert(!playSheet.includes("kr.verthill.app"), "modal has no stale package");
assert(!homeCta.includes("kr.verthill.app"), "home CTA has no stale package");
assert(!homeCta.includes("promptInstall();") || homeCta.includes("onOpenWebApp"), "BIP is not the primary home click");
assert(
  !/async function onClick\(\)[\s\S]*promptInstall/.test(homeCta),
  "home primary click does not fire PWA prompt"
);
assert(playSheet.includes("PLAY_INSTALL_TITLE"), "Play modal title from helper");
assert(playSheet.includes("PLAY_INSTALL_CTA_LABEL"), "Play modal CTA from helper");
assert(playSheet.includes("PLAY_INSTALL_STEPS"), "Play modal uses Android steps");
assert(playSheet.includes("PLAY_INSTALL_MISSING_URL"), "Play modal shows missing URL copy");
assert(playSheet.includes("PLAY_INSTALL_WEBAPP_LABEL"), "Play modal keeps web-app option");
assert(playSheet.includes('window.open(playUrl, "_blank", "noopener,noreferrer")'), "opens new tab");
assert(playSheet.includes("disabled={!playUrl}"), "CTA disabled without URL");
assert(!playSheet.includes("play.google.com"), "Play URL is not hardcoded in modal");
assert(!playLib.includes("play.google.com"), "Play URL is not hardcoded in helper");
assert(playLib.includes("NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL"), "helper documents env name");
assert(
  playLib.includes("process.env.NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL"),
  "static NEXT_PUBLIC access so Next can inline"
);
assert(
  playSheet.includes("process.env.NEXT_PUBLIC_GOOGLE_PLAY_TEST_URL"),
  "modal reads NEXT_PUBLIC env statically"
);
assert(playSheet.includes("readGooglePlayTestUrl"), "modal validates env URL");
assert(homeCta.includes("PwaInstallHintSheet"), "PWA sheet still available");
assert(homeCta.includes("shouldOfferWebAppInstall"), "web-app option is gated");
assert(pwaSheet.includes("pwaInstallHintSteps"), "existing PWA sheet unchanged");
assert(!loginClient.includes("PlayInstallSheet"), "login not coupled to Play modal");
assert(!caddyPage.includes("PlayInstallSheet"), "/caddy not coupled to Play modal");
assert(loginClient.includes("PwaInstallCard"), "login still has PWA card");
assert(caddyPage.includes("PwaInstallCard"), "/caddy still has PWA card");

section("no leftover PWA-first home flow + no push/auth changes");
assert(!home.includes("PwaInstallCard"), "home has no install card");
assert(!homeCta.includes("PushManager"), "home CTA no push");
assert(!playSheet.includes("PushManager"), "Play modal no push");
assert(!playLib.includes("requestPermission"), "Play helper no notification permission");
assert(!playSheet.includes("Kakao"), "Play modal no Kakao");
assert(!playLib.includes("/api/auth"), "Play helper no auth");

const privacy = readSrc("src/app/privacy/page.tsx");
assert(privacy.length > 0, "privacy page untouched (exists)");
assert(!privacy.includes("PlayInstallSheet"), "privacy not coupled to Play modal");

if (failed > 0) {
  console.error(`\nPlay install tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nPlay install tests passed: ${passed}`);
