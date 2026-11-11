/**
 * Android Capacitor notice-file download: JS policy + native plugin source.
 * No network. No production. No device.
 *
 * 실행: npm run test:notice-file-android-download-unit
 */
import fs from "node:fs";
import path from "node:path";
import { NOTICE_FILE_MAX_BYTES } from "../src/lib/noticeFileConstants";
import {
  NOTICE_FILE_NATIVE_ALLOWED_HOSTS,
  NOTICE_FILE_NATIVE_PLUGIN_NAME,
  confirmNativeNoticeDownloadResult,
  isNoticeFileNativeDownloadPath,
  nativeNoticeDownloadErrorCode,
  nativeNoticeDownloadFilename,
  nativeNoticeDownloadUserMessage,
  noticeFileDownloadMode,
  noticeFileNativeDownloadPath,
} from "../src/lib/noticeFileNativeDownload";

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

function throws(fn: () => unknown, msg: string) {
  try {
    fn();
    assert(false, msg);
  } catch {
    assert(true, msg);
  }
}

async function main() {
  const policy = read("src/lib/noticeFileNativeDownload.ts");
  const client = read("src/lib/noticeFileClient.ts");
  const nativeClient = read("src/lib/noticeFileNativeDownloadClient.ts");
  const list = read("src/components/notice/NoticeFileList.tsx");
  const css = read("src/app/globals.css");
  const mainActivity = read(
    "android/app/src/main/java/kr/verthill/caddy/MainActivity.java"
  );
  const plugin = read(
    "android/app/src/main/java/kr/verthill/caddy/notice/NoticeFileDownloadPlugin.java"
  );
  const javaPolicy = read(
    "android/app/src/main/java/kr/verthill/caddy/notice/NoticeFileDownloadPolicy.java"
  );
  const manifest = read("android/app/src/main/AndroidManifest.xml");
  const filePaths = read("android/app/src/main/res/xml/file_paths.xml");
  const chrome = read(
    "android/app/src/main/java/kr/verthill/caddy/VerthillBridgeWebChromeClient.java"
  );
  const kakao = read(
    "android/app/src/main/java/kr/verthill/caddy/kakao/KakaoNativeAuthPlugin.java"
  );
  const cfg = read("capacitor.config.ts");

  console.log("== download mode ==");
  assert(noticeFileDownloadMode({ isNativePlatform: false, pluginAvailable: false }) === "web", "browser/PWA uses web");
  assert(noticeFileDownloadMode({ isNativePlatform: false, pluginAvailable: true }) === "web", "PWA ignores plugin");
  assert(
    noticeFileDownloadMode({ isNativePlatform: true, pluginAvailable: true }) === "native",
    "Capacitor with plugin uses native"
  );
  assert(
    noticeFileDownloadMode({ isNativePlatform: true, pluginAvailable: false }) === "missing_plugin",
    "old APK does not fake a web download"
  );

  console.log("== path allowlist ==");
  assert(
    noticeFileNativeDownloadPath(12, 34) === "/api/notice/12/files/34?download=1",
    "plugin path is relative notice file URL"
  );
  assert(isNoticeFileNativeDownloadPath("/api/notice/12/files/34?download=1"), "download=1 allowed");
  assert(isNoticeFileNativeDownloadPath("/api/notice/12/files/34"), "path without query allowed");
  assert(!isNoticeFileNativeDownloadPath("/api/notice/12/files/34?download=1&token=x"), "no extra query");
  assert(!isNoticeFileNativeDownloadPath("https://www.verthill.kr/api/notice/12/files/34"), "full URL rejected");
  assert(!isNoticeFileNativeDownloadPath("/api/notice/12/files/34#x"), "fragment rejected");
  assert(!isNoticeFileNativeDownloadPath("/api/notice/../files/34"), "dot-dot rejected");
  assert(!isNoticeFileNativeDownloadPath("/api/chat/1/files/2"), "non-notice path rejected");
  assert(!isNoticeFileNativeDownloadPath("/api/notice/0/files/1"), "zero id rejected");
  assert(noticeFileNativeDownloadPath(0, 1) === null, "builder rejects zero notice id");
  assert(noticeFileNativeDownloadPath(1, 1.5) === null, "builder rejects non-integer");
  assert(
    NOTICE_FILE_NATIVE_ALLOWED_HOSTS.join(",") === "www.verthill.kr,verthill.kr",
    "JS allowlist matches capacitor hosts"
  );

  console.log("== filename / result confirmation ==");
  assert(nativeNoticeDownloadFilename("일정.xlsx") === "일정.xlsx", "xlsx name");
  assert(nativeNoticeDownloadFilename("안내.xls") === "안내.xls", "xls name");
  assert(nativeNoticeDownloadFilename("공지.hwp") === "공지.hwp", "hwp name");
  assert(nativeNoticeDownloadFilename("공지.hwpx") === "공지.hwpx", "hwpx name");
  assert(nativeNoticeDownloadFilename("안내.pdf") === "안내.pdf", "pdf name");
  assert(nativeNoticeDownloadFilename("x.exe") == null, "unknown ext rejected");
  assert(
    confirmNativeNoticeDownloadResult({ saved: true, displayName: "안내.xlsx" }).displayName ===
      "안내.xlsx",
    "confirmed save keeps name"
  );
  throws(
    () => confirmNativeNoticeDownloadResult({ saved: true }),
    "saved without filename is not success"
  );
  throws(
    () => confirmNativeNoticeDownloadResult({ saved: "true", displayName: "a.pdf" }),
    "string saved is not success"
  );
  throws(
    () => confirmNativeNoticeDownloadResult({ displayName: "a.pdf" }),
    "missing saved is not success"
  );
  throws(
    () => confirmNativeNoticeDownloadResult({ saved: true, displayName: "a.exe" }),
    "unknown ext result is not success"
  );

  console.log("== error mapping ==");
  assert(nativeNoticeDownloadErrorCode({ code: "UNIMPLEMENTED" }) === "unavailable", "missing plugin");
  assert(nativeNoticeDownloadErrorCode({ code: "unauthorized" }) === "unauthorized", "auth code");
  assert(nativeNoticeDownloadErrorCode({ message: "boom" }) === "download_failed", "opaque fallback");
  assert(
    nativeNoticeDownloadUserMessage("unavailable") ===
      "앱을 업데이트하면 첨부파일을 저장할 수 있습니다.",
    "old APK asks for update"
  );
  assert(nativeNoticeDownloadUserMessage("unauthorized") === "로그인이 필요합니다.", "auth message");
  assert(
    nativeNoticeDownloadUserMessage("too_large") === "20MB를 초과하는 파일은 저장할 수 없습니다.",
    "size message"
  );
  assert(
    !nativeNoticeDownloadUserMessage("https://evil.example/secret").includes("http"),
    "user message never echoes a URL"
  );

  console.log("== JS wiring ==");
  assert(NOTICE_FILE_NATIVE_PLUGIN_NAME === "NoticeFileDownload", "plugin name");
  assert(nativeClient.includes(`registerPlugin<NoticeFileDownloadPlugin>(`), "registerPlugin");
  assert(nativeClient.includes('download: (opts: {'), "download method");
  assert(nativeClient.includes("path, filename"), "plugin args are path+filename");
  assert(!nativeClient.includes("accessToken"), "native client has no token");
  assert(!nativeClient.includes("vh_session"), "native client has no session cookie");
  assert(nativeClient.includes("consumeUnauthorizedMemberResponse"), "401 still redirects");
  assert(client.includes("if (input.native === true)"), "native branch");
  {
    const downloadFn = client.slice(client.indexOf("export async function downloadNoticeFile"));
    assert(
      downloadFn.includes("downloadNoticeFileOnNative") &&
        downloadFn.indexOf("downloadNoticeFileOnNative") <
          downloadFn.indexOf("triggerBlobDownload"),
      "native save runs instead of blob click"
    );
  }
  assert(
    client.includes("URL.createObjectURL") &&
      client.includes("a.download") &&
      client.includes("triggerBlobDownload"),
    "browser/PWA blob download remains"
  );
  assert(
    client.includes("return { confirmed: false") &&
      client.includes("confirmed: true"),
    "web download is not reported as confirmed"
  );
  assert(
    list.includes("readCapacitorNativePlatform()") && list.includes("native,"),
    "list passes native flag"
  );
  assert(list.includes("outcome.confirmed === true"), "success UI requires confirmed save");
  assert(list.includes("다운로드 폴더에 저장했습니다."), "native success copy");
  assert(list.includes("notice-files-note is-ok"), "success is not danger color");
  assert(css.includes(".notice-files-note.is-ok"), "ok note style");
  assert(!list.includes("createObjectURL"), "list does not invent blob URLs");

  console.log("== Android plugin ==");
  assert(
    mainActivity.includes("registerPlugin(NoticeFileDownloadPlugin.class)"),
    "plugin registered"
  );
  assert(
    mainActivity.indexOf("registerPlugin(NoticeFileDownloadPlugin.class)") <
      mainActivity.indexOf("super.onCreate(savedInstanceState)"),
    "plugin registers before BridgeActivity onCreate"
  );
  assert(
    mainActivity.indexOf("registerPlugin(KakaoNativeAuthPlugin.class)") <
      mainActivity.indexOf("registerPlugin(NoticeFileDownloadPlugin.class)"),
    "Kakao registration order unchanged"
  );
  assert(plugin.includes('@CapacitorPlugin(\n    name = "NoticeFileDownload"'), "Capacitor name");
  assert(plugin.includes("CookieManager.getInstance().getCookie"), "WebView cookies on HTTP");
  assert(plugin.includes("MediaStore.Downloads"), "MediaStore Downloads");
  assert(plugin.includes("IS_PENDING"), "pending until write finishes");
  assert(plugin.includes("IS_PENDING, 0"), "clears pending after write");
  assert(plugin.includes("copyLimited"), "streamed copy");
  assert(
    javaPolicy.includes("COPY_BUFFER_BYTES = 8192") &&
      javaPolicy.includes("MAX_BYTES = 20 * 1024 * 1024"),
    "20MB cap with 8KB buffer"
  );
  assert(NOTICE_FILE_MAX_BYTES === 20 * 1024 * 1024, "JS max is 20MB");
  assert(
    !plugin.includes("android.util.Base64") &&
      !plugin.includes("Base64.encode") &&
      !javaPolicy.includes("Base64"),
    "no Base64 bridge"
  );
  assert(!plugin.includes("DownloadManager"), "not fire-and-forget DownloadManager");
  assert(
    !plugin.includes("webView.loadUrl") && !plugin.includes(".loadUrl("),
    "plugin does not navigate WebView"
  );
  assert(javaPolicy.includes('"www.verthill.kr"') && javaPolicy.includes('"verthill.kr"'), "Java hosts");
  assert(javaPolicy.includes("/api/notice/"), "Java path prefix");
  assert(javaPolicy.includes("download=1"), "forces attachment query");
  assert(plugin.includes('call.getString("path"') && plugin.includes('call.getString("filename"'), "path+name only");
  assert(!plugin.includes("getString(\"url\""), "no URL argument");
  assert(!plugin.includes("Log.") && !javaPolicy.includes("Log."), "no Android logs");
  assert(!plugin.includes("setRequestProperty(\"Authorization\""), "no Authorization header");
  assert(plugin.includes("HttpURLConnection") && plugin.includes("HttpsURLConnection"), "https only");
  assert(plugin.includes("setInstanceFollowRedirects(false)"), "manual allowlisted redirects");
  assert(javaPolicy.includes("MAX_REDIRECTS = 3"), "redirect cap");
  assert(plugin.includes("HTTP_UNAUTHORIZED") && plugin.includes("unauthorized"), "401 mapped");
  assert(plugin.includes("too_large"), "oversize mapped");
  assert(plugin.includes("permission_denied"), "legacy storage permission mapped");
  assert(plugin.includes("WRITE_EXTERNAL_STORAGE"), "legacy storage alias");
  assert(plugin.includes("SDK_INT < Build.VERSION_CODES.Q"), "storage perm only below API 29");
  assert(
    /WRITE_EXTERNAL_STORAGE"\s+android:maxSdkVersion="28"/.test(manifest.replace(/\s+/g, " ")) ||
      manifest.includes('android:name="android.permission.WRITE_EXTERNAL_STORAGE"') &&
        manifest.includes('android:maxSdkVersion="28"'),
    "WRITE_EXTERNAL_STORAGE is maxSdk 28"
  );
  assert(!manifest.includes("READ_EXTERNAL_STORAGE"), "no READ_EXTERNAL_STORAGE");
  assert(!manifest.includes("MANAGE_EXTERNAL_STORAGE"), "no all-files access");
  assert(
    filePaths.includes('<cache-path name="heic_jpeg" path="heic-jpeg/" />') &&
      !filePaths.includes("external-path"),
    "FileProvider still heic-jpeg only"
  );
  assert(
    cfg.includes('"www.verthill.kr"') &&
      cfg.includes('"verthill.kr"') &&
      !cfg.includes("kauth.kakao.com"),
    "allowNavigation unchanged"
  );
  assert(chrome.includes("HeicNativeJpegConverter") && chrome.includes("onShowFileChooser"), "file picker intact");
  assert(kakao.includes("loginWithKakaoTalk") && kakao.includes("loginWithKakaoAccount"), "Kakao intact");
  assert(
    plugin.includes("cleanupFailedSave") && plugin.includes("resolver.delete"),
    "failed writes delete pending rows"
  );
  assert(plugin.includes('ret.put("saved", true)'), "resolve only after save");
  assert(!plugin.includes("addJavascriptInterface"), "no extra JS interface");

  if (failed) {
    console.error(`\nFAILED ${failed} / ${passed + failed}`);
    process.exit(1);
  }
  console.log(`\nOK ${passed}`);
}

void main();
