/**
 * VERTHILL Android/Capacitor security hardening (static, no network, no prod).
 * 실행: npm run test:android-security-hardening-unit
 */
import fs from "node:fs";
import path from "node:path";
import { FCM_ANDROID_CHANNEL_ID } from "../src/lib/fcmHttpV1";
import {
  NATIVE_KAKAO_LOGIN_ENABLED,
  runKakaoLogin,
  shouldUseNativeKakaoLogin,
} from "../src/lib/kakaoNativeBridge";
import {
  migrateNativePushPrivacyChannel,
  NATIVE_PUSH_CHANNEL_ID,
  NATIVE_PUSH_CHANNEL_ID_LEGACY,
  NATIVE_PUSH_CHANNEL_IMPORTANCE,
  NATIVE_PUSH_CHANNEL_NAME,
  NATIVE_PUSH_CHANNEL_VISIBILITY_PRIVATE,
  nativePushChannelCreateSpec,
} from "../src/lib/nativePushChannel";

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

async function main() {
  const cfg = read("capacitor.config.ts");
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  const filePaths = read("android/app/src/main/res/xml/file_paths.xml");
  const appGradle = read("android/app/build.gradle");
  const pushChannels = read(
    "android/app/src/main/java/kr/verthill/caddy/VerthillPushChannels.java"
  );
  const verthillApp = read(
    "android/app/src/main/java/kr/verthill/caddy/VerthillApp.java"
  );
  const kakaoPlugin = read(
    "android/app/src/main/java/kr/verthill/caddy/kakao/KakaoNativeAuthPlugin.java"
  );
  const heicConverter = read(
    "android/app/src/main/java/kr/verthill/caddy/HeicNativeJpegConverter.java"
  );
  const chromeClient = read(
    "android/app/src/main/java/kr/verthill/caddy/VerthillBridgeWebChromeClient.java"
  );
  const bridge = read("src/lib/nativePushBridge.ts");

  console.log("== backup ==");
  assert(manifest.includes('android:allowBackup="false"'), "allowBackup false");
  assert(!manifest.includes('android:allowBackup="true"'), "allowBackup true removed");
  assert(
    !manifest.includes("dataExtractionRules") &&
      !manifest.includes("fullBackupContent"),
    "no extra backup XML (allowBackup=false is enough)"
  );

  console.log("== Kakao allowNavigation ==");
  assert(cfg.includes('"www.verthill.kr"'), "allowNavigation keeps www.verthill.kr");
  assert(cfg.includes('"verthill.kr"'), "allowNavigation keeps verthill.kr");
  assert(!cfg.includes('"kauth.kakao.com"'), "no kauth.kakao.com allowNavigation");
  assert(!cfg.includes('"accounts.kakao.com"'), "no accounts.kakao.com allowNavigation");
  assert(
    !cfg.includes('"*.kakao.com"') && !cfg.includes("*.kakao."),
    "no wildcard Kakao allowNavigation"
  );
  assert(!cfg.includes("kapi.kakao.com"), "kapi is not a WebView host");

  console.log("== native Kakao login independent of WebView hosts ==");
  assert(NATIVE_KAKAO_LOGIN_ENABLED === true, "native Kakao flag on");
  assert(
    shouldUseNativeKakaoLogin({ isNativePlatform: true }) === true,
    "native platform uses Kakao SDK"
  );
  assert(
    kakaoPlugin.includes("loginWithKakaoTalk") &&
      kakaoPlugin.includes("loginWithKakaoAccount") &&
      kakaoPlugin.includes("UserApiClient") &&
      !kakaoPlugin.includes("allowNavigation") &&
      !kakaoPlugin.includes("kauth.kakao.com") &&
      !kakaoPlugin.includes("accounts.kakao.com") &&
      !kakaoPlugin.includes("loadUrl"),
    "KakaoNativeAuthPlugin is SDK-only, no WebView OAuth hosts"
  );
  assert(
    read("src/lib/kakaoNativeBridge.ts").includes(
      "POST /api/auth/kakao/native-session"
    ) && read("src/lib/kakaoNativeBridge.ts").includes("KakaoNativeAuth.login"),
    "JS native path is plugin → native-session"
  );

  const native = await runKakaoLogin({
    isNativePlatform: true,
    callbackUrl: "/caddy",
    nativeLogin: async () => ({ accessToken: "mem-only" }),
    exchangeSession: async (token) => {
      assert(token === "mem-only", "native-session receives SDK token");
      return { role: "caddy", href: "/caddy" };
    },
  });
  assert(native.mode === "native" && native.href === "/caddy", "native login contract");

  console.log("== push channel privacy ==");
  assert(NATIVE_PUSH_CHANNEL_ID === "verthill-private", "new channel id");
  assert(NATIVE_PUSH_CHANNEL_ID_LEGACY === "verthill", "legacy PUBLIC id");
  assert(NATIVE_PUSH_CHANNEL_ID !== NATIVE_PUSH_CHANNEL_ID_LEGACY, "ids differ");
  assert(NATIVE_PUSH_CHANNEL_NAME === "VERTHILL", "display name unchanged");
  assert(NATIVE_PUSH_CHANNEL_IMPORTANCE === 4, "importance HIGH unchanged");
  assert(
    NATIVE_PUSH_CHANNEL_VISIBILITY_PRIVATE === 0,
    "visibility PRIVATE (not PUBLIC 1)"
  );
  assert(FCM_ANDROID_CHANNEL_ID === NATIVE_PUSH_CHANNEL_ID, "FCM uses PRIVATE channel");
  assert(
    manifest.includes('android:value="verthill-private"'),
    "manifest default channel is verthill-private"
  );
  assert(
    !/android:value="verthill"\s*\/>/.test(manifest),
    "manifest does not default to leftover PUBLIC id"
  );
  assert(
    pushChannels.includes('CHANNEL_ID = "verthill-private"') &&
      pushChannels.includes('CHANNEL_ID_LEGACY = "verthill"') &&
      pushChannels.includes("IMPORTANCE_HIGH") &&
      pushChannels.includes("VISIBILITY_PRIVATE") &&
      pushChannels.includes("createNotificationChannel") &&
      pushChannels.indexOf("createNotificationChannel") <
        pushChannels.indexOf("deleteNotificationChannel"),
    "native create PRIVATE then delete leftover PUBLIC"
  );
  assert(
    verthillApp.includes("VerthillPushChannels.ensurePrivateChannel"),
    "Application creates PRIVATE channel before WebView"
  );
  assert(
    bridge.includes("migrateNativePushPrivacyChannel") &&
      !bridge.includes("visibility: 1"),
    "JS bridge migrates channel and no longer sets PUBLIC"
  );

  const spec = nativePushChannelCreateSpec();
  assert(spec.id === "verthill-private", "create spec id");
  assert(spec.visibility === 0, "create spec PRIVATE");
  assert(spec.importance === 4, "create spec HIGH");
  const order: string[] = [];
  await migrateNativePushPrivacyChannel({
    createChannel: async (channel) => {
      order.push(`create:${channel.id}:${channel.visibility}`);
    },
    deleteChannel: async (id) => {
      order.push(`delete:${id}`);
    },
  });
  assert(
    order.join("|") === "create:verthill-private:0|delete:verthill",
    "migrate creates PRIVATE before deleting PUBLIC leftover"
  );

  let deleted = false;
  try {
    await migrateNativePushPrivacyChannel({
      createChannel: async () => {
        throw new Error("create failed");
      },
      deleteChannel: async () => {
        deleted = true;
      },
    });
    assert(false, "create failure should throw");
  } catch (e) {
    assert(
      e instanceof Error && e.message === "create failed" && deleted === false,
      "create failure keeps leftover channel so notifications still exist"
    );
  }

  console.log("== FileProvider scope ==");
  assert(
    filePaths.includes('<cache-path name="heic_jpeg" path="heic-jpeg/" />'),
    "FileProvider exposes cache/heic-jpeg only"
  );
  assert(!filePaths.includes("external-path"), "no broad external-path");
  assert(!filePaths.includes('path="."'), "no cache/external root path");
  assert(
    heicConverter.includes('CACHE_DIR_NAME = "heic-jpeg"') &&
      heicConverter.includes("FileProvider.getUriForFile"),
    "HEIC converter is the FileProvider producer"
  );
  assert(
    !chromeClient.includes("FileProvider") &&
      chromeClient.includes("HeicNativeJpegConverter"),
    "chrome client does not expose extra FileProvider roots"
  );
  assert(
    !read("src/app/chat/ChatClient.tsx").includes("capture=") &&
      !read("src/app/course-reports/CourseReportForm.tsx").includes("capture=") &&
      !read("src/app/notice/new/ui/NewNoticeForm.tsx").includes("capture="),
    "photo inputs do not use capture= (Capacitor camera FileProvider unused)"
  );

  console.log("== Android version frozen ==");
  assert(appGradle.includes("versionCode 14"), "versionCode 14");
  assert(appGradle.includes('versionName "1.0.9"'), "versionName 1.0.9");
  assert(
    !cfg.includes("certificatePinner") && !cfg.includes("certificate pinning"),
    "no certificate pinning in this PR"
  );

  if (failed) {
    console.error(`\nFAILED ${failed} / ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

void main();
