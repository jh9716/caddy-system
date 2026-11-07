/**
 * Client parked WS reuse: production default off; ON-assumption security.
 * No network / Worker / DB.
 * 실행: npm run test:chat-ws-reuse-unit
 */
import fs from "node:fs";
import {
  PRODUCTION_CHAT_WS_REUSE_ENABLED,
  CHAT_WS_REUSE_TTL_MS,
  canResumeParked,
  classifyParkedResumeSkip,
  classifyParkedResumeWaitResult,
  isParkExpired,
  parkedResumeClientGate,
  resolveChatWsReuse,
  type ParkedSocketMeta,
} from "../src/lib/chatWsReuse";

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

function read(rel: string) {
  return fs.readFileSync(new URL(`../${rel}`, import.meta.url), "utf8");
}

const prodEnv = { VERCEL_ENV: "production", VERCEL: "1" };
const previewEnv = { VERCEL_ENV: "preview", VERCEL: "1" };
const meta: ParkedSocketMeta = { roomId: "all", token: "tok-a", exp: 2_000_000_000 };

function main() {
  section("production default off");
  assert(PRODUCTION_CHAT_WS_REUSE_ENABLED === false, "PRODUCTION_CHAT_WS_REUSE_ENABLED is false");
  assert(resolveChatWsReuse(prodEnv).enabled === false, "production resolve is off");
  assert(resolveChatWsReuse(previewEnv).enabled === false, "preview resolve is also off on this slice");
  assert(resolveChatWsReuse(prodEnv, { productionEnabled: false }).enabled === false, "explicit off");
  assert(
    resolveChatWsReuse({}).enabled === false,
    "local default (treated as production env) still follows the const"
  );

  section("production ON-assumption");
  assert(resolveChatWsReuse(prodEnv, { productionEnabled: true }).enabled === true, "test override enables reuse");
  assert(
    resolveChatWsReuse(previewEnv, { productionEnabled: true }).enabled === true,
    "ON-assumption works regardless of Vercel env"
  );

  section("eligibility");
  const nowSec = 1_700_000_000;
  const nowMs = 1_700_000_000_000;
  assert(
    canResumeParked(meta, {
      roomId: "all",
      token: "tok-a",
      nowSec,
      socketOpen: true,
      parkedAt: nowMs,
      nowMs,
    }) === true,
    "same room/token/open/fresh park is eligible"
  );
  assert(
    classifyParkedResumeSkip(null, {
      roomId: "all",
      token: "tok-a",
      nowSec,
      socketOpen: true,
    }) === "no_park",
    "no park"
  );
  assert(
    classifyParkedResumeSkip(meta, {
      roomId: "all",
      token: "tok-a",
      nowSec,
      socketOpen: false,
      parkedAt: nowMs,
      nowMs,
    }) === "socket_closed",
    "closed socket cannot resume"
  );
  assert(
    classifyParkedResumeSkip(meta, {
      roomId: "room_other",
      token: "tok-a",
      nowSec,
      socketOpen: true,
      parkedAt: nowMs,
      nowMs,
    }) === "room_mismatch",
    "other room cannot reuse"
  );
  assert(
    classifyParkedResumeSkip(meta, {
      roomId: "all",
      token: "tok-b",
      nowSec,
      socketOpen: true,
      parkedAt: nowMs,
      nowMs,
    }) === "token_mismatch",
    "other token cannot reuse"
  );
  assert(
    classifyParkedResumeSkip(meta, {
      roomId: "all",
      token: "tok-a",
      nowSec: meta.exp - 10,
      socketOpen: true,
      parkedAt: nowMs,
      nowMs,
    }) === "token_expiring",
    "token within 30s of expiry cannot reuse"
  );
  assert(
    classifyParkedResumeSkip(meta, {
      roomId: "all",
      token: "tok-a",
      nowSec,
      socketOpen: true,
      parkedAt: nowMs - CHAT_WS_REUSE_TTL_MS - 1,
      nowMs,
    }) === "park_expired",
    "TTL expiry cannot reuse"
  );
  assert(isParkExpired(undefined, nowMs) === true, "missing parkedAt is expired");
  assert(isParkExpired(nowMs + 10, nowMs) === true, "backwards clock is expired");

  section("resume wait / gate");
  assert(parkedResumeClientGate("history") === "history", "history completes resume");
  assert(parkedResumeClientGate("error") === "fail", "error fails resume");
  assert(parkedResumeClientGate("message") === "hold", "message held until history");
  assert(parkedResumeClientGate("sync") === "hold", "sync held until history");
  assert(parkedResumeClientGate("read") === "other", "other frames ignored for wait");
  assert(
    classifyParkedResumeWaitResult({
      gotHistory: true,
      gotError: false,
      closed: false,
      timedOut: false,
    }) === "ok",
    "history is success"
  );
  assert(
    classifyParkedResumeWaitResult({
      gotHistory: false,
      gotError: true,
      closed: true,
      timedOut: false,
    }) === "resume_auth",
    "error/close is resume_auth"
  );
  assert(
    classifyParkedResumeWaitResult({
      gotHistory: false,
      gotError: false,
      closed: false,
      timedOut: true,
    }) === "resume_timeout",
    "timeout without error"
  );

  section("ChatClient wiring");
  const client = read("src/app/chat/ChatClient.tsx");
  assert(client.includes("dropParkedRoomSocket();"), "logout/session reset drops parked socket");
  assert(client.includes("subscribeChatSessionReset"), "session reset subscription present");
  assert(client.includes("if (!parkRoomSocket()) wsRef.current?.close()"), "leave parks only when enabled");
  assert(client.includes('{ type: "resume" }') || client.includes("{ type: \"resume\" }") || client.includes('type: "resume"'), "resume frame is sent");
  assert(!client.includes("chatPerfDiag"), "no chatPerf in ChatClient");
  assert(!client.includes("CHAT_WS_REUSE_STORAGE_KEY"), "no Preview sessionStorage reuse flag");
  assert(client.includes("PRODUCTION_CHAT_WS_REUSE_ENABLED") === false, "ChatClient uses resolveChatWsReuse, not a local flip");

  const resetAt = client.lastIndexOf("subscribeChatSessionReset(");
  const reset = client.slice(resetAt, resetAt + 500);
  assert(reset.includes("dropParkedRoomSocket"), "session reset calls dropParkedRoomSocket first");

  if (failed > 0) {
    console.error(`\nchat-ws-reuse tests failed: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nchat-ws-reuse tests passed: ${passed}`);
}

main();
