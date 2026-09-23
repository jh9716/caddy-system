/**
 * VERTHILL Play PREPARE — Android release signing guards.
 * No keystore generation. No secret values. No network required.
 *
 * 실행: npm run test:android-release-signing-unit
 */
import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

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

const appGradle = read("android/app/build.gradle");
const rootGradle = read("android/build.gradle");
const variables = read("android/variables.gradle");
const cfg = read("capacitor.config.ts");
const manifest = read("android/app/src/main/AndroidManifest.xml");
const strings = read("android/app/src/main/res/values/strings.xml");
const capacitorBuild = read("android/app/capacitor.build.gradle");
const capacitorSettings = read("android/capacitor.settings.gradle");
const pushGradle = read(
  "node_modules/@capacitor/push-notifications/android/build.gradle"
);
const capAndroidGradle = read("node_modules/@capacitor/android/capacitor/build.gradle");
const gitignore = read(".gitignore");
const androidGitignore = read("android/.gitignore");
const envExample = read("android/release-signing.env.example");
const kakaoHashScript = read("scripts/compute-android-kakao-debug-key-hash.ts");
const workflowRel = ".github/workflows/android-release-aab.yml";
const workflow = exists(workflowRel) ? read(workflowRel) : "";
const pkgJson = JSON.parse(read("package.json")) as { engines?: { node?: string } };

const envNames = [
  "ANDROID_KEYSTORE_PATH",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
];

const signingBlock = appGradle.slice(
  appGradle.indexOf("def releaseSigningEnvNames"),
  appGradle.indexOf("repositories {")
);
const googleServicesBlock = appGradle.slice(appGradle.indexOf("google-services.json"));

console.log("== env-only release signing ==");
for (const name of envNames) {
  assert(appGradle.includes(`"${name}"`), `Gradle reads ${name}`);
  assert(envExample.includes(name), `example documents ${name}`);
}
assert(
  /System\.getenv\(name\)/.test(signingBlock) &&
    !signingBlock.includes("findProperty") &&
    !signingBlock.includes("local.properties") &&
    !signingBlock.includes("kakao.properties"),
  "release signing reads process env only"
);
assert(
  envExample.includes("Gradle reads process env, not this file"),
  "example file is not a secret source"
);

console.log("== no hardcoded release secrets ==");
assert(
  /storeFile file\("debug\.keystore"\)/.test(appGradle) &&
    /storePassword "android"/.test(appGradle) &&
    /keyAlias "androiddebugkey"/.test(appGradle),
  "debug signing stays on the standard debug.keystore"
);
assert(
  !/storeFile file\(["'](?!debug\.keystore)[^"']+["']\)/.test(appGradle),
  "release storeFile is not a hardcoded path"
);
assert(
  signingBlock.includes('readReleaseSigningEnv("ANDROID_KEYSTORE_PASSWORD")') &&
    signingBlock.includes('readReleaseSigningEnv("ANDROID_KEY_ALIAS")') &&
    signingBlock.includes('readReleaseSigningEnv("ANDROID_KEY_PASSWORD")'),
  "release passwords/alias come from env helpers"
);
assert(
  !appGradle.includes("keytool") &&
    !appGradle.includes("-genkeypair") &&
    !appGradle.includes("keytool -genkey"),
  "Gradle does not generate an upload keystore"
);

console.log("== no debug fallback on release ==");
const buildTypesBlock = appGradle.slice(
  appGradle.indexOf("buildTypes {"),
  appGradle.indexOf("compileOptions {")
);
const releaseBuildType = buildTypesBlock.slice(buildTypesBlock.lastIndexOf("release {"));
assert(
  /if \(releaseSigningReady\) \{[\s\S]*signingConfig signingConfigs\.release/.test(
    releaseBuildType
  ),
  "release signingConfig is applied only when env+file are ready"
);
assert(
  !releaseBuildType.includes("signingConfigs.debug"),
  "release never assigns signingConfigs.debug"
);
assert(
  appGradle.includes("debug keystore fallback is disabled"),
  "signed release tasks refuse missing env instead of using debug"
);
assert(
  ["assembleRelease", "bundleRelease", "signRelease", "signReleaseBundle"].every(
    (name) => appGradle.includes(`"${name}"`)
  ),
  "signed release lifecycle tasks are gated"
);
assert(
  appGradle.includes('tasks.register("checkReleaseSigning")'),
  "checkReleaseSigning reports readiness without secrets"
);

console.log("== secrets stay out of git and logs ==");
assert(
  !/logger\.[^(]*\([^)]*releaseKeystorePath/.test(appGradle) &&
    !/logger\.[^(]*\([^)]*ANDROID_KEYSTORE_PASSWORD/.test(appGradle) &&
    !/logger\.[^(]*\([^)]*ANDROID_KEY_PASSWORD/.test(appGradle) &&
    !/logger\.[^(]*\([^)]*ANDROID_KEY_ALIAS/.test(appGradle) &&
    !/logger\.[^(]*\([^)]*readReleaseSigningEnv/.test(appGradle),
  "Gradle does not log keystore path, alias, or passwords"
);
assert(androidGitignore.includes("*.keystore"), "android/.gitignore ignores keystores");
assert(androidGitignore.includes("*.jks"), "android/.gitignore ignores jks");
assert(gitignore.includes("android/app/debug.keystore"), "root gitignore keeps debug.keystore local");
assert(gitignore.includes("*.aab"), "AAB artifacts are not committed");
assert(!gitTracked("android/app/debug.keystore"), "debug.keystore is not tracked");
assert(!gitTracked("android/app/google-services.json"), "google-services.json is not tracked");
assert(
  !gitTracked("android/release-signing.env") && exists("android/release-signing.env.example"),
  "only the empty release-signing example is present"
);
assert(
  execSync("git ls-files -- '*.keystore' '*.jks' '*.aab'", { encoding: "utf8" }).trim() ===
    "",
  "no keystore/jks/aab files are tracked"
);

console.log("== Firebase / Kakao / Capacitor stay on the existing production path ==");
assert(
  googleServicesBlock.includes("apply plugin: 'com.google.gms.google-services'") &&
    googleServicesBlock.includes("google-services.json not found") &&
    googleServicesBlock.includes("catch(Exception e)") &&
    googleServicesBlock.includes("logger.lifecycle"),
  "missing google-services.json still skips the plugin instead of failing config"
);
assert(
  rootGradle.includes("com.google.gms:google-services:4.4.4"),
  "google-services classpath unchanged"
);
assert(
  capacitorBuild.includes("implementation project(':capacitor-push-notifications')"),
  "PushNotifications plugin remains in capacitor.build.gradle"
);
assert(
  capacitorSettings.includes(":capacitor-push-notifications"),
  "capacitor.settings.gradle still includes PushNotifications"
);
assert(
  manifest.includes("POST_NOTIFICATIONS") &&
    strings.includes("kr.verthill.caddy") &&
    appGradle.includes('applicationId "kr.verthill.caddy"'),
  "package, applicationId, and POST_NOTIFICATIONS stay"
);
assert(
  cfg.includes('url: "https://www.verthill.kr"') &&
    cfg.includes('appId: "kr.verthill.caddy"') &&
    cfg.includes('appName: "VERTHILL"'),
  "Capacitor appId/appName/server.url are unchanged"
);
assert(
  appGradle.includes("KAKAO_NATIVE_APP_KEY") &&
    appGradle.includes("kakao_unconfigured") &&
    !/logger\.[^(]*\([^)]*kakaoNativeAppKey/.test(appGradle),
  "Kakao native key stays injectable and is not logged"
);
assert(
  kakaoHashScript.includes('EXPECTED_DEBUG_KAKAO_KEY_HASH = "M9h5pMYFj0yFLApYg+RqeR/8sdI="'),
  "debug Kakao key hash remains locked"
);

console.log("== version + SDK policy ==");
assert(
  appGradle.includes("versionCode 6") && appGradle.includes('versionName "1.0.5"'),
  "Play candidate versionCode 6 / versionName 1.0.5"
);
assert(
  variables.includes("compileSdkVersion = 36") &&
    variables.includes("targetSdkVersion = 36") &&
    variables.includes("minSdkVersion = 24"),
  "compileSdk 36 / targetSdk 36 / minSdk 24"
);

console.log("== first-party native modules have no bundled .so ==");
assert(
  !exists("android/app/src/main/jniLibs") &&
    !exists("android/app/src/main/jni") &&
    !capAndroidGradle.includes("externalNativeBuild") &&
    !capAndroidGradle.includes("jniLibs") &&
    !pushGradle.includes("externalNativeBuild") &&
    !pushGradle.includes("jniLibs"),
  "app/Capacitor/PushNotifications Gradle has no first-party jniLibs"
);
assert(
  !exists("node_modules/@capacitor/android/capacitor/src/main/jniLibs") &&
    !exists("node_modules/@capacitor/push-notifications/android/src/main/jniLibs"),
  "Capacitor Android sources ship no jniLibs directories"
);
assert(
  pushGradle.includes("firebase-messaging:$firebaseMessagingVersion") &&
    pushGradle.includes("firebaseMessagingVersion") &&
    pushGradle.includes("25.0.1"),
  "PushNotifications resolves firebase-messaging 25.0.1 by default"
);
assert(
  variables.includes("datastoreVersion = '1.2.1'") &&
    appGradle.includes('details.requested.group == "androidx.datastore"') &&
    appGradle.includes("rootProject.ext.datastoreVersion") &&
    !appGradle.includes("firebase-messaging:") &&
    pushGradle.includes("com.google.firebase:firebase-messaging:$firebaseMessagingVersion"),
  "datastore 1.2.1 is pinned for 16KB; firebase-messaging version is unchanged"
);

console.log("== workflow_dispatch AAB release ==");
assert(exists(workflowRel) && gitTracked(workflowRel), "android-release-aab.yml is tracked");
assert(
  /^on:\n  workflow_dispatch:\n/m.test(workflow) &&
    !/^\s+push:/m.test(workflow) &&
    !/^\s+pull_request:/m.test(workflow) &&
    !/^\s+schedule:/m.test(workflow) &&
    !/^\s+workflow_run:/m.test(workflow) &&
    !/^\s+release:/m.test(workflow),
  "workflow_dispatch is the only trigger"
);
assert(
  workflow.includes("runs-on: ubuntu-latest") &&
    workflow.includes('java-version: "21"') &&
    workflow.includes("node-version-file: package.json") &&
    String(pkgJson.engines?.node || "").startsWith("24"),
  "ubuntu + Java 21 + package.json engines Node"
);
assert(workflow.includes("npm ci"), "workflow uses repo-standard npm ci");
assert(
  workflow.includes("npx cap sync android") &&
    workflow.includes("./gradlew --no-daemon --console=plain bundleRelease"),
  "workflow runs cap sync android and bundleRelease"
);
for (const name of [
  "ANDROID_UPLOAD_KEYSTORE_B64",
  "GOOGLE_SERVICES_JSON_B64",
  "ANDROID_KEYSTORE_PATH",
  "ANDROID_KEYSTORE_PASSWORD",
  "ANDROID_KEY_ALIAS",
  "ANDROID_KEY_PASSWORD",
  "KAKAO_NATIVE_APP_KEY",
]) {
  assert(workflow.includes(name), `workflow injects ${name}`);
}
assert(
  workflow.includes("RUNNER_TEMP") &&
    !/ANDROID_KEYSTORE_PATH: \$\{\{ runner\./.test(workflow) &&
    workflow.includes("base64 -d") &&
    workflow.includes("android/app/google-services.json") &&
    workflow.includes("if: always()") &&
    workflow.includes("Cleanup runner release inputs"),
  "secrets are restored to runner temp and always cleaned up"
);
const uploadBlock = workflow.slice(
  workflow.indexOf("Upload app-release.aab"),
  workflow.indexOf("Cleanup runner release inputs")
);
assert(
  uploadBlock.includes("name: app-release.aab") &&
    uploadBlock.includes(
      "path: android/app/build/outputs/bundle/release/app-release.aab"
    ) &&
    uploadBlock.includes("retention-days: 7") &&
    uploadBlock.includes("if-no-files-found: error") &&
    !uploadBlock.includes(".jks") &&
    !uploadBlock.includes("local.properties") &&
    !uploadBlock.includes("kakao.properties") &&
    !uploadBlock.includes("google-services.json") &&
    !uploadBlock.includes("ANDROID_KEYSTORE_PASSWORD") &&
    !workflow.includes("path: android/app/google-services.json"),
  "artifact is app-release.aab only, retention 7 days"
);
assert(
  workflow.includes('application_id != "kr.verthill.caddy"') &&
    workflow.includes("version_code) != 6") &&
    workflow.includes('version_name) != "1.0.5"') &&
    workflow.includes(
      "11:98:3D:66:F4:39:F2:CD:88:0E:1D:50:21:08:9C:2B:B5:EB:7F:2D:69:CC:93:36:CA:44:96:AA:8F:98:75:E5"
    ) &&
    workflow.includes("android debug") &&
    workflow.includes("processReleaseGoogleServices") &&
    workflow.includes("Kakao native app key: configured"),
  "workflow verifies package, version, upload cert, Kakao, and Google Services"
);
assert(
  !gitTracked(".cursor-transfer/pr181-release-inputs.gpg") &&
    !gitTracked("android/app/google-services.json") &&
    execSync("git ls-files -- '*.jks' '*.keystore' '*.aab' '.cursor-transfer/*'", {
      encoding: "utf8",
    }).trim() === "",
  "JKS, google-services.json, AAB, and encrypted transfer stay untracked"
);

if (failed) {
  console.error(`\nFAILED ${failed} / ${passed + failed}`);
  process.exit(1);
}
console.log(`\nOK ${passed}`);
