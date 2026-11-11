/**
 * Debug-only Preview Android download hosts + isolated debug APK workflow.
 * No network. No production secrets. No Play submit.
 *
 * 실행: npm run test:android-debug-preview-unit
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync } from "node:child_process";
import {
  ANDROID_DEBUG_PREVIEW_DEFAULT_URL,
  androidDebugPreviewHostFromUrl,
  isAndroidDebugPreviewHost,
} from "../src/lib/androidDebugPreviewHost";

let passed = 0;
let failed = 0;

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), "utf8");
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
const appGradle = read("android/app/build.gradle");
const debugHosts = read(
  "android/app/src/debug/java/kr/verthill/caddy/notice/NoticeFileDownloadFlavorHosts.java"
);
const releaseHosts = read(
  "android/app/src/release/java/kr/verthill/caddy/notice/NoticeFileDownloadFlavorHosts.java"
);
const policy = read(
  "android/app/src/main/java/kr/verthill/caddy/notice/NoticeFileDownloadPolicy.java"
);
const workflow = read(".github/workflows/android-debug-apk.yml");
const releaseWorkflow = read(".github/workflows/android-release-aab.yml");
const gitignore = read("android/.gitignore");

console.log("== Preview host allowlist ==");
assert(
  androidDebugPreviewHostFromUrl(ANDROID_DEBUG_PREVIEW_DEFAULT_URL) ===
    "caddy-system-gt8t-git-cursor-android-no-4bcddd-jh9716s-projects.vercel.app",
  "default PR Preview git alias is allowed"
);
assert(
  isAndroidDebugPreviewHost(
    "caddy-system-gt8t-9c8n5dwjn-jh9716s-projects.vercel.app"
  ),
  "unique Preview dpl host is allowed"
);
assert(!isAndroidDebugPreviewHost("www.verthill.kr"), "production www is not a debug extra host");
assert(!isAndroidDebugPreviewHost("verthill.kr"), "production apex is not a debug extra host");
assert(!isAndroidDebugPreviewHost("caddy-system-gt8t.vercel.app"), "project vercel.app blocked");
assert(
  !isAndroidDebugPreviewHost("caddy-system-gt8t-git-main-jh9716s-projects.vercel.app"),
  "git-main Preview alias blocked"
);
assert(!androidDebugPreviewHostFromUrl("http://example.com"), "http rejected");
assert(
  !androidDebugPreviewHostFromUrl(
    "https://evil.vercel.app/caddy-system-gt8t-git-x-jh9716s-projects.vercel.app"
  ),
  "path smuggle rejected"
);
assert(
  !androidDebugPreviewHostFromUrl(`${ANDROID_DEBUG_PREVIEW_DEFAULT_URL}?token=1`),
  "query rejected"
);

console.log("== flavor split ==");
assert(
  debugHosts.includes("caddy-system-gt8t-git-[a-z0-9-]{1,80}-jh9716s-projects") &&
    debugHosts.includes("extraAllowed"),
  "debug FlavorHosts allows Preview git aliases"
);
assert(
  releaseHosts.includes("static boolean extraAllowed") &&
    releaseHosts.includes("return false") &&
    !releaseHosts.includes("vercel.app"),
  "release FlavorHosts has no Preview host"
);
assert(
  policy.includes("NoticeFileDownloadFlavorHosts.extraAllowed") &&
    policy.includes('"www.verthill.kr"') &&
    policy.includes('"verthill.kr"'),
  "main policy keeps production hosts and delegates extras"
);
assert(
  cfg.includes('url: "https://www.verthill.kr"') &&
    !cfg.includes("vercel.app") &&
    cfg.includes('"www.verthill.kr"') &&
    cfg.includes('"verthill.kr"'),
  "capacitor.config.ts Release URL/hosts unchanged"
);
assert(
  appGradle.includes("versionCode 14") && appGradle.includes('versionName "1.0.9"'),
  "versionCode 14 / 1.0.9 frozen"
);
{
  const buildTypes = appGradle.slice(appGradle.indexOf("    buildTypes {"));
  const debugType = buildTypes.slice(
    buildTypes.indexOf("debug {"),
    buildTypes.indexOf("release {")
  );
  const releaseType = buildTypes.slice(buildTypes.indexOf("release {"));
  assert(debugType.includes('applicationIdSuffix ".debug"'), "debug suffix .debug");
  assert(!releaseType.includes("applicationIdSuffix"), "release has no applicationIdSuffix");
  assert(
    appGradle.includes('applicationId "kr.verthill.caddy"'),
    "defaultConfig applicationId stays kr.verthill.caddy"
  );
}
const debugStrings = read("android/app/src/debug/res/values/strings.xml");
const mainStrings = read("android/app/src/main/res/values/strings.xml");
assert(debugStrings.includes(">VERTHILL 테스트<"), "debug launcher label");
assert(mainStrings.includes(">VERTHILL<") && !mainStrings.includes("테스트"), "release label unchanged");
assert(debugStrings.includes("kr.verthill.caddy.debug"), "debug package_name/custom scheme");
assert(
  mainStrings.includes(">kr.verthill.caddy<") && !mainStrings.includes(".debug"),
  "release package_name unchanged"
);
assert(
  read("android/app/src/main/AndroidManifest.xml").includes(
    'android:authorities="${applicationId}.fileprovider"'
  ),
  "FileProvider authority follows applicationId"
);
assert(
  read("android/app/src/main/java/kr/verthill/caddy/HeicNativeJpegConverter.java").includes(
    'context.getPackageName() + ".fileprovider"'
  ),
  "HEIC FileProvider uses runtime package name"
);

console.log("== debug overlay writer ==");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "vh-debug-cap-"));
const overlay = path.resolve("android/app/src/debug/assets/capacitor.config.json");
const existed = fs.existsSync(overlay);
const previous = existed ? fs.readFileSync(overlay, "utf8") : null;
try {
  execSync(
    `bash scripts/tsx-safe.sh scripts/write-android-debug-capacitor-config.ts --url ${ANDROID_DEBUG_PREVIEW_DEFAULT_URL}`,
    { encoding: "utf8" }
  );
  const written = read("android/app/src/debug/assets/capacitor.config.json");
  assert(written.includes(ANDROID_DEBUG_PREVIEW_DEFAULT_URL), "overlay writes Preview URL");
  assert(written.includes("www.verthill.kr"), "overlay keeps production allowNavigation");
  assert(!written.includes("kauth.kakao.com"), "overlay has no Kakao hosts");
  try {
    execSync(
      "bash scripts/tsx-safe.sh scripts/write-android-debug-capacitor-config.ts --url https://www.verthill.kr",
      { encoding: "utf8", stdio: "pipe" }
    );
    assert(false, "writer rejects production URL as Preview overlay");
  } catch {
    assert(true, "writer rejects production URL as Preview overlay");
  }
} finally {
  if (previous == null) {
    fs.rmSync(overlay, { force: true });
  } else {
    fs.writeFileSync(overlay, previous);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("== isolated debug APK workflow ==");
assert(workflow.includes("name: Android Debug APK"), "debug workflow name");
assert(workflow.includes("pull_request:") && workflow.includes("workflow_dispatch:"), "PR + dispatch");
assert(!workflow.includes("bundleRelease") && !workflow.includes("assembleRelease"), "no release bundle");
assert(workflow.includes("assembleDebug"), "assembleDebug");
assert(workflow.includes("kr.verthill.caddy.debug"), "CI checks debug applicationId");
assert(workflow.includes('pkg.group(1) != "kr.verthill.caddy.debug"'), "CI fails if debug id wrong");
assert(
  workflow.includes('release_pkg != "kr.verthill.caddy"'),
  "CI checks release applicationId has no .debug"
);
assert(workflow.includes("compileReleaseJavaWithJavac"), "release Java compile guard");
assert(workflow.includes("native:android-debug-preview-config"), "writes debug overlay");
assert(workflow.includes("ephemeral debug.keystore"), "throwaway debug cert");
assert(workflow.includes("Upload app-debug.apk"), "uploads debug APK");
assert(workflow.includes("retention-days: 7"), "7 day artifact");
assert(!workflow.includes("${{ secrets."), "debug workflow does not read GitHub secrets");
for (const secret of [
  "ANDROID_UPLOAD_KEYSTORE_B64",
  "GOOGLE_SERVICES_JSON_B64",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
  "KAKAO_NATIVE_APP_KEY",
]) {
  assert(
    !workflow.includes(`secrets.${secret}`) &&
      !workflow.includes(`${secret}: \${{`),
    `debug workflow does not inject ${secret}`
  );
}
assert(
  workflow.includes("Refuse production secrets") &&
    workflow.includes("no production signing or Kakao secrets in debug job"),
  "debug job fails if production secrets leak into env"
);
assert(
  gitignore.includes("app/src/debug/assets/capacitor.config.json"),
  "generated debug overlay is gitignored"
);
assert(
  releaseWorkflow.includes("workflow_dispatch:") &&
    !/^\s+pull_request:/m.test(releaseWorkflow),
  "Play AAB workflow remains dispatch-only"
);

if (failed) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
