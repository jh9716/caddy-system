/**
 * Android Capacitor system back — decision matrix + wiring.
 * No network. No production login. No Android SDK required.
 *
 * 실행: npm run test:android-system-back-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  applyAndroidSystemBack,
  isAuthHistoryPath,
  isChatPath,
  peekAndroidBackOverlays,
  registerAndroidChatRoomLeave,
  registerAndroidDrawerClose,
  resetAndroidBackOverlaysForTests,
  resolveAndroidSystemBack,
  shouldRegisterAndroidSystemBack,
} from "../src/lib/androidSystemBack";

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

function read(rel: string): string {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("platform gate");
{
  assert(
    shouldRegisterAndroidSystemBack({ isNativePlatform: true, platform: "android" }),
    "Android native registers"
  );
  assert(
    !shouldRegisterAndroidSystemBack({ isNativePlatform: false, platform: "android" }),
    "web Android UA does not register"
  );
  assert(
    !shouldRegisterAndroidSystemBack({ isNativePlatform: false, platform: "web" }),
    "browser does not register"
  );
  assert(
    !shouldRegisterAndroidSystemBack({ isNativePlatform: true, platform: "ios" }),
    "iOS native does not register"
  );
}

section("path helpers");
{
  assert(isChatPath("/chat"), "/chat is chat");
  assert(isChatPath("/chat/"), "/chat/ is chat");
  assert(!isChatPath("/caddy"), "/caddy is not chat");
  assert(isAuthHistoryPath("/login"), "/login is auth");
  assert(isAuthHistoryPath("/login?callbackUrl=/caddy"), "/login query is auth");
  assert(isAuthHistoryPath("/admin/login"), "/admin/login is auth");
  assert(!isAuthHistoryPath("/caddy"), "/caddy is not auth");
  assert(!isAuthHistoryPath("/chat"), "/chat is not auth");
}

section("back matrix");
{
  assert(
    resolveAndroidSystemBack({
      drawerOpen: true,
      inChatRoom: true,
      pathname: "/chat",
      canGoBack: true,
    }) === "close-drawer",
    "drawer wins over room and history"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: true,
      pathname: "/chat",
      canGoBack: true,
    }) === "leave-chat-room",
    "/chat room → list before history"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: true,
      pathname: "/notice",
      canGoBack: true,
    }) === "history-back",
    "stale room flag ignored off /chat"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/chat",
      canGoBack: true,
    }) === "history-back",
    "/chat list → previous screen"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/notice",
      canGoBack: true,
    }) === "history-back",
    "/caddy → /notice → back"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/course-reports",
      canGoBack: true,
    }) === "history-back",
    "/board → /course-reports → back"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/caddy",
      canGoBack: false,
    }) === "noop",
    "root /caddy no-op, no exit loop"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/",
      canGoBack: false,
    }) === "noop",
    "root / no-op"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/login",
      canGoBack: true,
    }) === "noop",
    "login does not history.back into expired member pages"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: false,
      inChatRoom: false,
      pathname: "/admin/login",
      canGoBack: true,
    }) === "noop",
    "admin login no-op"
  );
  assert(
    resolveAndroidSystemBack({
      drawerOpen: true,
      inChatRoom: false,
      pathname: "/caddy",
      canGoBack: false,
    }) === "close-drawer",
    "root + open drawer closes drawer"
  );
}

section("apply hooks");
{
  const calls: string[] = [];
  applyAndroidSystemBack("close-drawer", {
    closeDrawer: () => calls.push("drawer"),
    leaveChatRoom: () => calls.push("room"),
    historyBack: () => calls.push("back"),
  });
  applyAndroidSystemBack("leave-chat-room", {
    closeDrawer: () => calls.push("drawer"),
    leaveChatRoom: () => calls.push("room"),
    historyBack: () => calls.push("back"),
  });
  applyAndroidSystemBack("history-back", {
    closeDrawer: () => calls.push("drawer"),
    leaveChatRoom: () => calls.push("room"),
    historyBack: () => calls.push("back"),
  });
  applyAndroidSystemBack("noop", {
    closeDrawer: () => calls.push("drawer"),
    leaveChatRoom: () => calls.push("room"),
    historyBack: () => calls.push("back"),
  });
  assert(calls.join(",") === "drawer,room,back", "apply calls only the matching hook");
}

section("overlay registry");
{
  resetAndroidBackOverlaysForTests();
  assert(!peekAndroidBackOverlays().drawerOpen, "drawer starts closed");
  const offDrawer = registerAndroidDrawerClose(() => {});
  assert(peekAndroidBackOverlays().drawerOpen, "drawer register");
  offDrawer();
  assert(!peekAndroidBackOverlays().drawerOpen, "drawer unregister");
  const offRoom = registerAndroidChatRoomLeave(() => {});
  assert(peekAndroidBackOverlays().inChatRoom, "room register");
  offRoom();
  assert(!peekAndroidBackOverlays().inChatRoom, "room unregister");
}

section("wiring — no Chat Phase 2");
{
  const pkg = read("package.json");
  const bootstrap = read("src/components/AndroidSystemBackBootstrap.tsx");
  const layout = read("src/app/layout.tsx");
  const chrome = read("src/components/manage/AppChrome.tsx");
  const chat = read("src/app/chat/ChatClient.tsx");
  const login = read("src/app/login/LoginClient.tsx");
  const logout = read("src/components/LogoutButton.tsx");
  const gradle = read("android/capacitor.settings.gradle");
  const capBuild = read("android/app/capacitor.build.gradle");
  const mainActivity = read(
    "android/app/src/main/java/kr/verthill/caddy/MainActivity.java"
  );
  const src = read("src/lib/androidSystemBack.ts");

  assert(pkg.includes('"@capacitor/app"'), "@capacitor/app dependency");
  assert(pkg.includes("test:android-system-back-unit"), "npm test script");
  assert(gradle.includes("capacitor-app"), "cap sync includes App plugin");
  assert(capBuild.includes("capacitor-app"), "app gradle implements App plugin");
  assert(
    bootstrap.includes('addListener("backButton"') ||
      bootstrap.includes("addListener('backButton'"),
    "bootstrap listens backButton"
  );
  assert(
    bootstrap.includes("shouldRegisterAndroidSystemBack"),
    "bootstrap gated to Android native"
  );
  assert(!bootstrap.includes("exitApp"), "no App.exitApp");
  assert(layout.includes("AndroidSystemBackBootstrap"), "root layout mounts bootstrap");
  assert(chrome.includes("registerAndroidDrawerClose"), "drawer registers closer");
  assert(chat.includes("registerAndroidChatRoomLeave"), "chat room registers leave");
  assert(chat.includes('useState<"list" | "room">("list")'), "chat still list/room state");
  assert(!chat.includes("searchParams"), "no Chat Phase 2 room URL");
  assert(!/model\s+ChatMessage/.test(read("prisma/schema.prisma")), "no ChatMessage model");
  assert(
    login.includes("location.replace") &&
      login.includes("resolvePostLoginHref") &&
      login.includes("location.replace(result.href)"),
    "post-login uses replace, not assign"
  );
  assert(
    login.includes("location.href = result.startUrl"),
    "Kakao REST start still assign"
  );
  assert(logout.includes('location.replace("/")'), "logout replace home");
  assert(logout.includes('location.replace("/login")'), "logout-all replace login");
  assert(
    !mainActivity.includes("onBackPressed") &&
      !mainActivity.includes("OnBackPressed"),
    "MainActivity stays stock; App plugin owns native back"
  );
  assert(src.includes("history-back"), "decision helper exported");
  assert(
    !read("src/app/caddy/page.tsx").includes("androidSystemBack"),
    "caddy page not rewritten"
  );
}

if (failed > 0) {
  console.error(`\nandroid-system-back tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nandroid-system-back tests passed: ${passed}`);
