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
  const mw = read("src/middleware.ts");
  assert(mw.includes('"/chat"'), "middleware matcher /chat");
  const nav = read("src/lib/boardNav.ts");
  assert(nav.includes('href: "/chat"'), "drawer 채팅");
  const css = read("src/app/globals.css");
  assert(css.includes(".vh-chat"), "chat css");
  assert(css.includes("min(390px, 100%)"), "390px first");
  assert(css.includes(".vh-chat-bubble.is-admin"), "admin superchat style");
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
  assert(!chat.includes("내 조 채팅방"), "team rooms hidden from default UI");
}

section("no neon chat schema");
{
  const schema = read("prisma/schema.prisma");
  assert(!/model\s+ChatMessage/.test(schema), "no ChatMessage model");
  assert(!/model\s+ChatRoom/.test(schema), "no ChatRoom model");
  const migrations = fs.readdirSync("prisma/migrations");
  assert(!migrations.some((name) => /chat/i.test(name)), "no chat prisma migration");
}

section("worker auth + directory");
{
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  assert(worker.includes("verifyChatToken"), "worker verifies token");
  assert(worker.includes("serializeAttachment"), "claims on hibernated socket");
  assert(worker.includes("sender_user_id"), "persists senderUserId");
  assert(worker.includes("sender_role"), "persists senderRole from token");
  assert(worker.includes("CHAT_DIRECTORY"), "directory binding used");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  assert(proto.includes("team-1"), "legacy team rooms still valid ids");
  assert(proto.includes('ALL_ROOM_ID = "all"'), "overall room id");
  assert(proto.includes("MAX_CONNECTIONS_ALL = 400"), "overall room cap 400");
  assert(proto.includes("MAX_CONNECTIONS = 200"), "custom/legacy cap 200");
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
