/**
 * /chat Phase 1 wiring — no DB.
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
  const mw = read("src/middleware.ts");
  assert(mw.includes('"/chat"'), "middleware matcher /chat");
  const nav = read("src/lib/boardNav.ts");
  assert(nav.includes('href: "/chat"'), "drawer 채팅");
  const css = read("src/app/globals.css");
  assert(css.includes(".vh-chat"), "chat css");
  assert(css.includes("min(390px, 100%)"), "390px first");
}

section("no neon chat schema");
{
  const schema = read("prisma/schema.prisma");
  assert(!/model\s+ChatMessage/.test(schema), "no ChatMessage model");
  const migrations = fs.readdirSync("prisma/migrations");
  assert(!migrations.some((name) => /chat/i.test(name)), "no chat prisma migration");
}

section("worker auth");
{
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  assert(worker.includes("verifyChatToken"), "worker verifies token");
  assert(worker.includes("serializeAttachment"), "claims on hibernated socket");
  assert(worker.includes("sender_user_id"), "persists senderUserId");
  const proto = read("cloudflare/verthill-chat/src/protocol.ts");
  assert(proto.includes("team-1"), "team rooms");
  assert(!proto.includes("poc-room"), "anonymous poc-room gone");
}

if (failed > 0) {
  console.error(`\nchat-ui tests failed: ${failed} (passed ${passed})`);
  process.exit(1);
}
console.log(`\nchat-ui tests passed: ${passed}`);
