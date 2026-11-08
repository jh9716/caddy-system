/**
 * Client parked WS reuse: production default off; ON-assumption security.
 * No network / Worker / DB.
 * 실행: npm run test:chat-ws-reuse-unit
 */
import fs from "node:fs";
import {
  PRODUCTION_CHAT_WS_REUSE_ENABLED,
  CHAT_WS_REUSE_TTL_MS,
  CHAT_WS_REUSE_RUNTIME_PATH,
  CHAT_WS_REUSE_RUNTIME_ENV,
  CHAT_WS_REUSE_RUNTIME_FETCH_TIMEOUT_MS,
  CHAT_WS_REUSE_RUNTIME_POLL_MS,
  CHAT_WS_REUSE_RUNTIME_RESPONSE_HEADERS,
  applyWsReuseRuntimeEnabled,
  canResumeParked,
  classifyParkedResumeSkip,
  classifyParkedResumeWaitResult,
  fetchChatWsReuseRuntimeEnabled,
  isParkExpired,
  parkedResumeClientGate,
  parseWsReuseRuntimeResponse,
  resolveChatWsReuse,
  resolveChatWsReuseRuntime,
  shouldParkChatWsReuse,
  type ParkedSocketMeta,
} from "../src/lib/chatWsReuse";
import { validateIncomingResume } from "../cloudflare/verthill-chat/src/protocol";

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

async function main() {
  section("production default off");
  assert(PRODUCTION_CHAT_WS_REUSE_ENABLED === true, "PRODUCTION_CHAT_WS_REUSE_ENABLED is true");
  assert(resolveChatWsReuse(prodEnv).enabled === true, "production resolve is on");
  assert(resolveChatWsReuse(previewEnv).enabled === false, "preview resolve stays off");
  assert(resolveChatWsReuse(prodEnv, { productionEnabled: false }).enabled === false, "explicit off");
  assert(
    resolveChatWsReuse({}).enabled === (PRODUCTION_CHAT_WS_REUSE_ENABLED === true),
    "local default (treated as production env) still follows the const"
  );

  section("production ON-assumption");
  assert(resolveChatWsReuse(prodEnv, { productionEnabled: true }).enabled === true, "test override enables reuse");
  assert(
    resolveChatWsReuse(previewEnv, { productionEnabled: true }).enabled === true,
    "ON-assumption works regardless of Vercel env"
  );

  section("runtime kill switch");
  assert(
    resolveChatWsReuseRuntime({ compileEnabled: false, appEnv: "production" }) === false,
    "compile off: runtime cannot enable"
  );
  assert(
    resolveChatWsReuseRuntime({ compileEnabled: true, appEnv: "preview" }) === false,
    "preview app env never parks"
  );
  assert(
    resolveChatWsReuseRuntime({ compileEnabled: true, appEnv: "production" }) === true,
    "compile on + production + unset env allows park"
  );
  assert(
    resolveChatWsReuseRuntime({
      compileEnabled: true,
      appEnv: "production",
      runtime: "0",
    }) === false,
    "CHAT_WS_REUSE_RUNTIME=0 immediately disables park"
  );
  assert(
    resolveChatWsReuseRuntime({
      compileEnabled: true,
      appEnv: "production",
      runtime: "off",
    }) === false,
    "runtime=off disables park"
  );
  assert(
    resolveChatWsReuseRuntime({
      compileEnabled: true,
      appEnv: "production",
      runtime: "false",
    }) === false,
    "runtime=false disables park"
  );
  assert(shouldParkChatWsReuse({ compileEnabled: true, runtimeEnabled: false }) === false, "park needs runtime true");
  assert(shouldParkChatWsReuse({ compileEnabled: false, runtimeEnabled: true }) === false, "park needs compile true");
  assert(shouldParkChatWsReuse({ compileEnabled: true, runtimeEnabled: true }) === true, "both gates allow park");
  assert(applyWsReuseRuntimeEnabled(true).runtimeEnabled === true, "runtime true keeps park");
  assert(applyWsReuseRuntimeEnabled(true).dropParked === false, "runtime true does not drop");
  assert(applyWsReuseRuntimeEnabled(false).runtimeEnabled === false, "runtime false disables");
  assert(applyWsReuseRuntimeEnabled(false).dropParked === true, "runtime false drops parked socket");
  assert(parseWsReuseRuntimeResponse({ enabled: true }) === true, "runtime JSON enabled true");
  assert(parseWsReuseRuntimeResponse({ enabled: false }) === false, "runtime JSON enabled false");
  assert(parseWsReuseRuntimeResponse({ enabled: "true" }) === false, "string true is fail-closed");
  assert(parseWsReuseRuntimeResponse(null) === false, "null runtime body is fail-closed");
  assert(CHAT_WS_REUSE_RUNTIME_PATH === "/api/chat/ws-reuse", "runtime path");
  assert(CHAT_WS_REUSE_RUNTIME_ENV === "CHAT_WS_REUSE_RUNTIME", "runtime env name");

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
  assert(parkedResumeClientGate("authorized") === "other", "authorized does not finish resume wait");
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
  assert(client.includes("leaveRoomSocket();"), "leave parks only when enabled");
  assert(client.includes("await refreshWsReuseRuntime()"), "park re-checks runtime API first");
  assert(client.includes("CHAT_WS_REUSE_RUNTIME_POLL_MS"), "open tabs poll after Instant Rollback");
  assert(client.includes("fetchChatWsReuseRuntimeEnabled"), "runtime fetch is fail-closed");
  assert(client.includes("wsRef.current !== ws"), "park aborts if the tab opened another room");
  assert(client.includes('{ type: "resume" }') || client.includes("{ type: \"resume\" }") || client.includes('type: "resume"'), "resume frame is sent");
  assert(!client.includes("chatPerfDiag"), "no chatPerf in ChatClient");
  assert(!client.includes("CHAT_WS_REUSE_STORAGE_KEY"), "no Preview sessionStorage reuse flag");
  assert(client.includes("PRODUCTION_CHAT_WS_REUSE_ENABLED") === false, "ChatClient uses resolveChatWsReuse, not a local flip");
  assert(client.includes("shouldParkChatWsReuse"), "park checks compile + runtime");
  assert(client.includes("applyWsReuseRuntimeEnabled"), "runtime poll drops parked sockets");
  assert(client.includes('addEventListener(\n      "close"') || client.includes('addEventListener(\n      "close",') || /addEventListener\(\s*"close"/.test(client), "parked socket close clears park");
  const eligibleAt = client.indexOf("const eligible = () =>");
  const eligible = client.slice(eligibleAt, eligibleAt + 450);
  assert(eligible.includes("shouldParkChatWsReuse"), "resume also requires runtime gate");

  const resetAt = client.lastIndexOf("subscribeChatSessionReset(");
  const reset = client.slice(resetAt, resetAt + 500);
  assert(reset.includes("dropParkedRoomSocket"), "session reset calls dropParkedRoomSocket first");

  const logoutClient = read("src/lib/logoutClient.ts");
  assert(logoutClient.includes('requestChatSessionReset("logout")'), "device logout resets chat before cookie logout");
  const logoutAll = read("src/app/api/auth/logout-all/route.ts");
  assert(logoutAll.includes("await notifyChatSessionRevoked"), "logout-all awaits Worker revoke");

  section("Worker resume protocol compatibility");
  assert(validateIncomingResume({ type: "resume" }).ok === true, "Worker accepts client resume payload");
  assert(validateIncomingResume({ type: "resume", extra: 1 }).ok === true, "resume extra keys still valid");
  assert(validateIncomingResume({ type: "history" }).ok === false, "history is not resume");
  assert(parkedResumeClientGate("error") === "fail", "Worker expire error fails client resume wait");
  const worker = read("cloudflare/verthill-chat/src/index.ts");
  assert(worker.includes("handleParkedResume"), "Worker parked resume handler");
  assert(worker.includes("parkedResumeVerdict"), "Worker fail-closed resume verdict");
  assert(worker.includes('this.expire(ws, verdict.close)'), "denied resume expires socket");
  assert(worker.includes("assertChatSessionCurrent"), "resume rechecks session");
  assert(worker.includes("isDirectoryMember") && worker.includes("resolveChatRoomAccess"), "resume rechecks membership");

  section("runtime API has no DB");
  const runtimeApi = read("src/app/api/chat/ws-reuse/route.ts");
  assert(runtimeApi.includes("resolveChatWsReuseRuntime"), "API uses runtime helper");
  assert(runtimeApi.includes("PRODUCTION_CHAT_WS_REUSE_ENABLED"), "API honors compile const");
  assert(!/prisma/i.test(runtimeApi), "runtime API does not touch Prisma");
  assert(!/DATABASE_URL|neon/i.test(runtimeApi), "runtime API has no DB URL");
  assert(runtimeApi.includes("CHAT_WS_REUSE_RUNTIME_RESPONSE_HEADERS"), "runtime API uses shared no-store headers");
  assert(runtimeApi.includes('fetchCache = "force-no-store"'), "runtime API disables Next fetch cache");
  assert(runtimeApi.includes("revalidate = 0"), "runtime API is not ISR");
  assert(!runtimeApi.includes("without a rebuild"), "API does not claim env changes skip redeploy");
  const reuseLib = read("src/lib/chatWsReuse.ts");
  assert(reuseLib.includes("Instant Rollback"), "docs Instant Rollback as emergency OFF");
  assert(reuseLib.includes("do not apply to an existing"), "docs that Vercel env changes skip live deployments");

  section("runtime API GET");
  const { GET } = await import("../src/app/api/chat/ws-reuse/route");
  const prevRuntime = process.env.CHAT_WS_REUSE_RUNTIME;
  delete process.env.CHAT_WS_REUSE_RUNTIME;
  const res = await GET();
  const body = (await res.json()) as { enabled?: unknown };
  assert(res.status === 200, "runtime API is 200");
  assert(
    body.enabled === (PRODUCTION_CHAT_WS_REUSE_ENABLED === true),
    "API enabled follows compile const on local production env"
  );
  assert(
    String(res.headers.get("cache-control") || "").includes("no-store"),
    "runtime API Cache-Control includes no-store"
  );
  assert(res.headers.get("cdn-cache-control") === "no-store", "runtime API CDN cache is no-store");
  assert(res.headers.get("vercel-cdn-cache-control") === "no-store", "Vercel CDN cache is no-store");
  assert(CHAT_WS_REUSE_RUNTIME_RESPONSE_HEADERS["cache-control"].includes("no-store"), "shared headers no-store");
  assert(CHAT_WS_REUSE_RUNTIME_POLL_MS === 5000, "open-tab poll is 5s");
  assert(CHAT_WS_REUSE_RUNTIME_FETCH_TIMEOUT_MS === 800, "park-time fetch timeout is 800ms");

  section("runtime fetch fail-closed");
  assert(
    (await fetchChatWsReuseRuntimeEnabled({
      fetch: async () => new Response(JSON.stringify({ enabled: true }), { status: 200 }),
    })) === true,
    "200 {enabled:true} allows park"
  );
  assert(
    (await fetchChatWsReuseRuntimeEnabled({
      fetch: async () => new Response(JSON.stringify({ enabled: false }), { status: 200 }),
    })) === false,
    "200 {enabled:false} after Instant Rollback disables park"
  );
  assert(
    (await fetchChatWsReuseRuntimeEnabled({
      fetch: async () => new Response("not found", { status: 404 }),
    })) === false,
    "404 (older OFF deploy without the route) disables park"
  );
  assert(
    (await fetchChatWsReuseRuntimeEnabled({
      fetch: async () => {
        throw new Error("network");
      },
    })) === false,
    "network error disables park"
  );
  assert(
    (await fetchChatWsReuseRuntimeEnabled({
      timeoutMs: 20,
      fetch: async (_url, init) =>
        new Promise((_, reject) => {
          const signal = init?.signal;
          if (signal) {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
          }
        }),
    })) === false,
    "timeout disables park"
  );
  process.env.CHAT_WS_REUSE_RUNTIME = "0";
  const off = await GET();
  const offBody = (await off.json()) as { enabled?: unknown };
  assert(offBody.enabled === false, "runtime=0 forces API off");
  if (prevRuntime == null) delete process.env.CHAT_WS_REUSE_RUNTIME;
  else process.env.CHAT_WS_REUSE_RUNTIME = prevRuntime;

  if (failed > 0) {
    console.error(`\nchat-ws-reuse tests failed: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nchat-ws-reuse tests passed: ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
