/**
 * /chat Phase 2 wiring — no DB.
 * 실행: npm run test:chat-ui-unit
 */
import fs from "node:fs";
import path from "node:path";

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

function read(rel: string) {
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function section(title: string) {
  console.log("\n==", title, "==");
}

section("routes and nav");
{
  assert(fs.existsSync("src/app/chat/page.tsx"), "/chat page");
  assert(fs.existsSync("src/app/chat/ChatClient.tsx"), "ChatClient");
  assert(fs.existsSync("src/app/api/chat/token/route.ts"), "token API");
  assert(fs.existsSync("src/app/api/chat/users/route.ts"), "user search API");
  assert(fs.existsSync("src/app/api/chat/rooms/route.ts"), "room create API");
  const users = read("src/app/api/chat/users/route.ts");
  assert(users.includes("resolveAuthUser"), "user search requires login");
  assert(users.includes("q.length < 1"), "empty q does not dump staff");
  assert(users.includes('scope === "all"'), "explicit scope=all invite pool");
  assert(users.includes("CHAT_USERS_ALL_TAKE"), "scope=all take is bounded");
  assert(!users.includes("phone"), "users API select has no phone");
  assert(!users.includes("kakao"), "users API select has no kakao");
  const mw = read("src/middleware.ts");
  assert(mw.includes('"/chat"'), "middleware matcher /chat");
  const nav = read("src/lib/boardNav.ts");
  assert(nav.includes('href: "/chat"'), "drawer 채팅");
  const manage = read("src/components/manage/ManageShell.tsx");
  assert(manage.includes('href: "/chat"'), "admin sidebar 채팅");
  assert(manage.includes('label: "채팅"'), "admin sidebar 채팅 label");
  const noticeIdx = manage.indexOf('label: "공지"');
  const chatIdx = manage.indexOf('label: "채팅"');
  assert(noticeIdx >= 0 && chatIdx > noticeIdx, "admin 채팅 sits near 공지");
  const css = read("src/app/globals.css");
  assert(css.includes(".vh-chat"), "chat css");
  assert(css.includes("min(390px, 100%)"), "390px first");
  assert(css.includes("vh-bottom-nav-height"), "chat height accounts for bottom nav");
  assert(css.includes(".vh-chat-log") && css.includes("min-height: 0"), "log scrolls inside viewport");
  assert(css.includes(".vh-chat-bubble.is-admin"), "admin superchat style");
  assert(css.includes("vh-chat-admin-badge"), "admin badge class");
  const chatClient = read("src/app/chat/ChatClient.tsx");
  assert(chatClient.includes('line.senderRole === "admin"'), "admin style uses stored senderRole");
  assert(
    chatClient.includes('<span className="vh-chat-admin-badge">관리자</span>'),
    "admin gold badge label"
  );
  assert(chatClient.includes("vh-chat-mention"), "mention highlight class");
  assert(chatClient.includes("나를 멘션"), "self mention label");
  assert(chatClient.includes("pickMention"), "autocomplete pick");
  assert(chatClient.includes("setMentionSuppressed(true)"), "android back closes mention panel");
  const layout = read("src/app/chat/layout.tsx");
  assert(layout.includes('auth.role !== "admin"'), "admin may enter /chat");
  assert(layout.includes("ManageShell"), "admin /chat uses ManageShell, not a separate page");
  assert(css.includes("vh-chat-unread"), "unread badge");
}

section("android back room leave");
{
  const chat = read("src/app/chat/ChatClient.tsx");
  assert(chat.includes("registerAndroidChatRoomLeave"), "room view registers Android back leave");
  assert(chat.includes("registerAndroidChatOverlayClose"), "create/members overlay back");
  assert(chat.includes('setView("list")'), "목록 still setView list");
  assert(chat.includes('useState<"list" | "room">("list")'), "chat still list/room state");
  assert(!chat.includes("searchParams"), "no room URL query");
  assert(chat.includes("전체 채팅방은 모든 활성") || chat.includes("ALL_ROOM_ID"), "overall room");
  assert(chat.includes("+ 채팅방 만들기"), "create room CTA");
  assert(chat.includes('sheet === "notify"'), "room notify sheet");
  assert(chat.includes("upsertVisibleChatRoom"), "DM optimistic upsert");
  assert(chat.includes("parseChatDeepLinkRoomId"), "chat deep link room");
  assert(!chat.includes("내 조 채팅방"), "team rooms hidden from default UI");
  assert(chat.includes("/api/chat/users?scope=all"), "create overlay fetches invite pool once");
  assert(chat.includes("전체 선택"), "bulk select all");
  assert(chat.includes("선택 해제"), "bulk clear");
  assert(chat.includes("visibleInviteRoles"), "role chips from real invite pool");
  const inviteSel = read("src/lib/chatInviteSelection.ts");
  assert(inviteSel.includes('caddy: "캐디 전체"'), "캐디 전체 is AppRole caddy only");
  assert(inviteSel.includes('leader: "리더"'), "리더 is separate role chip");
  assert(inviteSel.includes("role===caddy"), "캐디 전체 does not include leaders");
  assert(chat.includes("선택 {selectedCount}명"), "selection count footer");
  assert(chat.includes("invitePoolExcludingOwner"), "owner excluded from UI count");
  assert(!chat.includes("setInterval"), "no invite polling");
  const css = read("src/app/globals.css");
  assert(css.includes("vh-chat-chip"), "compact invite chips");
  assert(css.includes("vh-chat-sheet-create"), "create sheet flex layout");
  assert(css.includes("vh-chat-sheet-foot"), "create footer stays reachable");
}

section("no neon chat schema");
{
  const schema = read("prisma/schema.prisma");
  assert(!/model\s+ChatMessage/.test(schema), "no ChatMessage model");
  assert(!/model\s+ChatRoom\b/.test(schema), "no ChatRoom model");
  const migrations = fs.readdirSync("prisma/migrations");
  assert(
    migrations.some((name) => name.includes("chat_room_notification_pref")),
    "additive chat notification pref migration"
  );
  assert(
    !migrations.some((name) => /chat_message|chatroom(?!_notification)/i.test(name)),
    "no ChatMessage/ChatRoom tables"
  );
}

section("worker auth + directory");
{
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  assert(worker.includes("verifyChatToken"), "worker verifies token");
  assert(worker.includes("serializeAttachment"), "claims on hibernated socket");
  assert(worker.includes("sender_user_id"), "persists senderUserId");
  assert(worker.includes("sender_role"), "persists senderRole from token");
  assert(worker.includes("mentions_json"), "persists mentions_json");
  assert(worker.includes("mention_all"), "persists mention_all");
  assert(worker.includes("CHAT_DIRECTORY"), "directory binding used");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  assert(proto.includes("team-1"), "legacy team rooms still valid ids");
  assert(proto.includes('ALL_ROOM_ID = "all"'), "overall room id");
  assert(proto.includes("MAX_CONNECTIONS_ALL = 800"), "overall room cap 800");
  assert(proto.includes("MAX_CONNECTIONS = 200"), "custom/legacy cap 200");
  assert(proto.includes("HISTORY_PAGE_MAX = 50"), "history page max 50");
  assert(!worker.includes("trimHistory"), "no ChatRoom prune");
  assert(!/DELETE FROM messages\s*;/.test(worker), "messages are not wiped");
  assert(worker.includes("sent_at <"), "retention uses sent_at cutoff");
  assert(worker.includes("validateIncomingHistory"), "seq cursor history");
  assert(worker.includes("CHAT_INTERNAL_SECRET"), "internal secret name");
  assert(worker.includes("server_only"), "browser origin cannot create rooms");
  assert(worker.includes("queueChatPushDispatch"), "async chat push after persist");
  assert(worker.includes("CHAT_PUSH_DISPATCH_URL"), "optional Next dispatch URL");
  assert(worker.includes("/api/chat/push-dispatch"), "one backend path");
  const dir = read("cloudflare/verthill-chat/src/directory.ts");
  assert(dir.includes("verifyInternalRequest"), "directory internals require internal auth");
  assert(dir.includes("clampReadSeq"), "malicious read seq clamped");
  const chat = read("src/app/chat/ChatClient.tsx");
  assert(chat.includes("clientRequestId"), "create idempotency id");
  assert(chat.includes("beforeSeq"), "history pagination request");
  assert(chat.includes("이전 메시지"), "load older CTA");
  const token = read("src/lib/chatToken.ts");
  assert(token.includes("CHAT_TOKEN_TTL_SEC = 60 * 30"), "token TTL 30 min");
  const grant = read("src/lib/chatDirectoryGrant.ts");
  assert(grant.includes("CHAT_INTERNAL_SECRET"), "internal secret helper");
  assert(!grant.includes("NEXT_PUBLIC_CHAT_INTERNAL"), "internal secret not public");
  assert(!proto.includes("poc-room"), "anonymous poc-room gone");
  const wrangler = read("cloudflare/verthill-chat/wrangler.jsonc");
  assert(wrangler.includes("ChatDirectory"), "ChatDirectory class");
  assert(wrangler.includes('"tag": "v2"'), "non-destructive v2 migration");
  assert(wrangler.includes("ChatRoom"), "ChatRoom class kept");
}

if (failed > 0) {
  console.error(`\nchat-ui tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-ui tests passed: ${passed}`);
