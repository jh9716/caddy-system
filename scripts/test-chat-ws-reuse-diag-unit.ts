/**
 * Admin-only parked WS reuse diagnostics. No network / Worker / DB.
 * 실행: npm run test:chat-ws-reuse-diag-unit
 */
import fs from "node:fs";
import path from "node:path";
import {
  CHAT_WS_REUSE_DIAG_FORBIDDEN_KEYS,
  CHAT_WS_REUSE_DIAG_STORAGE_KEY,
  canRecordChatWsReuseDiag,
  getChatWsReuseDiagSnapshot,
  handleChatWsReuseDiagSessionReset,
  hydrateChatWsReuseDiagFromStorageForTests,
  isChatWsReuseDiagRecording,
  markChatWsReuseDiagLeftRoom,
  markChatWsReuseDiagRoomSelect,
  noteChatWsReuseDiagNewRoomSocket,
  noteChatWsReuseDiagNewWsHistory,
  noteChatWsReuseDiagParkAttempt,
  noteChatWsReuseDiagParkOk,
  noteChatWsReuseDiagParkSkip,
  noteChatWsReuseDiagResumeAttempt,
  noteChatWsReuseDiagResumeFail,
  noteChatWsReuseDiagResumeOk,
  noteChatWsReuseDiagTtlExpired,
  percentileMs,
  resetChatWsReuseDiag,
  resetChatWsReuseDiagForTests,
  reuseSuccessRate,
  reuseSuccessRateParts,
  diagLatencyStat,
  CHAT_WS_REUSE_DIAG_MIN_COMPARE_SAMPLES,
  startChatWsReuseDiag,
  stopChatWsReuseDiag,
} from "../src/lib/chatWsReuseDiag";
import { PRODUCTION_CHAT_WS_REUSE_ENABLED } from "../src/lib/chatWsReuse";

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
  return fs.readFileSync(path.resolve(rel), "utf8");
}

function installMemoryStorage() {
  const mem = new Map<string, string>();
  const storage = {
    getItem(key: string) {
      return mem.has(key) ? mem.get(key)! : null;
    },
    setItem(key: string, value: string) {
      mem.set(key, String(value));
    },
    removeItem(key: string) {
      mem.delete(key);
    },
    clear() {
      mem.clear();
    },
  };
  (globalThis as { sessionStorage?: typeof storage }).sessionStorage = storage;
  return storage;
}

async function main() {
  const storage = installMemoryStorage();
  resetChatWsReuseDiagForTests();

  section("default OFF");
  assert(isChatWsReuseDiagRecording() === false, "recording starts off");
  assert(canRecordChatWsReuseDiag("admin") === false, "admin still cannot record while off");
  assert(canRecordChatWsReuseDiag("caddy") === false, "caddy cannot record");
  noteChatWsReuseDiagNewRoomSocket();
  noteChatWsReuseDiagParkAttempt();
  noteChatWsReuseDiagResumeAttempt();
  noteChatWsReuseDiagResumeOk();
  assert(getChatWsReuseDiagSnapshot().newWs === 0, "OFF ignores new WS");
  assert(getChatWsReuseDiagSnapshot().parkAttempts === 0, "OFF ignores park");
  assert(getChatWsReuseDiagSnapshot().resumeAttempts === 0, "OFF ignores resume attempt");
  assert(getChatWsReuseDiagSnapshot().resumeOk === 0, "OFF ignores resume ok");

  section("admin allow / caddy deny");
  assert(startChatWsReuseDiag() === false, "start without adminAllowed fails");
  assert(startChatWsReuseDiag({ adminAllowed: false }) === false, "caddy/adminAllowed false fails");
  assert(isChatWsReuseDiagRecording() === false, "still off after denied start");
  assert(startChatWsReuseDiag({ adminAllowed: true }) === true, "admin start succeeds");
  assert(isChatWsReuseDiagRecording() === true, "recording on after admin start");
  assert(canRecordChatWsReuseDiag("admin") === true, "admin can record while on");
  assert(canRecordChatWsReuseDiag("caddy") === false, "caddy role still blocked");
  const page = read("src/app/manage/chat-ws-reuse-diag/page.tsx");
  assert(page.includes('auth.role !== "admin"'), "diag page requires admin");
  assert(page.includes("redirect("), "diag page redirects non-admin");
  const layout = read("src/app/manage/layout.tsx");
  assert(layout.includes('auth.role !== "admin"'), "manage layout already admin-only");
  const client = read("src/app/chat/ChatClient.tsx");
  assert(client.includes('tokenRef.current?.user.role === "admin"'), "ChatClient also requires admin role");

  section("measure on/off");
  noteChatWsReuseDiagNewRoomSocket();
  assert(getChatWsReuseDiagSnapshot().newWs === 1, "ON counts new WS");
  stopChatWsReuseDiag();
  assert(isChatWsReuseDiagRecording() === false, "stop turns recording off");
  const afterStop = getChatWsReuseDiagSnapshot().newWs;
  noteChatWsReuseDiagNewRoomSocket();
  assert(getChatWsReuseDiagSnapshot().newWs === afterStop, "OFF after stop ignores new events");
  assert(startChatWsReuseDiag({ adminAllowed: true }) === true, "restart keeps prior counts");
  assert(getChatWsReuseDiagSnapshot().newWs === afterStop, "restart does not reset counts");

  section("first entry vs reentry latencies");
  resetChatWsReuseDiag();
  markChatWsReuseDiagRoomSelect();
  noteChatWsReuseDiagNewRoomSocket();
  noteChatWsReuseDiagNewWsHistory();
  let snap = getChatWsReuseDiagSnapshot();
  assert(snap.newWs === 1, "first entry still counts as a new WS");
  assert(snap.newWsOnReentry === 0, "first entry is not a reentry new WS");
  assert(snap.newWsMs.length === 0, "first entry is not in new-WS reentry latency");
  assert(snap.resumeMs.length === 0, "first entry is not in resume latency");
  assert(snap.reentryMs.length === 0, "first entry is not in overall reentry latency");
  assert(reuseSuccessRate(snap) === null, "success rate ignores first-entry sockets");

  section("new WS vs park / resume");
  resetChatWsReuseDiag();
  noteChatWsReuseDiagParkAttempt();
  noteChatWsReuseDiagParkOk();
  markChatWsReuseDiagLeftRoom();
  markChatWsReuseDiagRoomSelect();
  noteChatWsReuseDiagResumeAttempt();
  noteChatWsReuseDiagResumeOk();
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.parkAttempts === 1, "park attempt counted");
  assert(snap.parkOk === 1, "park success counted");
  assert(snap.resumeAttempts === 1, "resume attempt counted");
  assert(snap.resumeOk === 1, "resume success counted");
  assert(snap.newWs === 0, "resume success is not a new WS");
  assert(snap.newWsOnReentry === 0, "resume success is not reentry new WS");
  assert(snap.resumeMs.length === 1, "resume success records resume reentry latency");
  assert(snap.newWsMs.length === 0, "resume success is not in new-WS reentry latency");
  assert(snap.reentryMs.length === 1, "resume success records overall reentry latency");
  assert(reuseSuccessRate(snap) === 1, "100% reuse when only resume ok");
  assert(reuseSuccessRateParts(snap).ok === 1, "rate numerator is resumeOk");
  assert(reuseSuccessRateParts(snap).den === 1, "rate denominator is resumeOk + newWsOnReentry");
  assert(reuseSuccessRateParts(snap).sufficient === false, "n=1 is not enough to confirm");

  markChatWsReuseDiagLeftRoom();
  markChatWsReuseDiagRoomSelect();
  noteChatWsReuseDiagNewRoomSocket();
  noteChatWsReuseDiagNewWsHistory();
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.newWs === 1, "fallback new WS counted");
  assert(snap.newWsOnReentry === 1, "fallback new WS on reentry counted");
  assert(snap.newWsMs.length === 1, "reentry new WS latency recorded");
  assert(snap.resumeMs.length === 1, "resume latency unchanged after fallback");
  assert(snap.reentryMs.length === 2, "overall reentry includes resume + new WS");
  assert(snap.resumeOk === 1, "resume ok unchanged after fallback");
  assert(reuseSuccessRate(snap) === 0.5, "success rate is resumeOk / (resumeOk + newWsOnReentry)");
  assert(diagLatencyStat(snap.resumeMs).n === 1, "resume latency n is resume samples");
  assert(diagLatencyStat(snap.newWsMs).n === 1, "new-WS latency n is reentry new WS samples");
  assert(diagLatencyStat(snap.reentryMs).n === 2, "overall reentry n is both paths");

  section("history before success");
  resetChatWsReuseDiag();
  markChatWsReuseDiagLeftRoom();
  markChatWsReuseDiagRoomSelect();
  noteChatWsReuseDiagResumeAttempt();
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.resumeAttempts === 1, "sending resume is an attempt");
  assert(snap.resumeOk === 0, "attempt is not success");
  assert(snap.resumeMs.length === 0, "resume latency waits for history");
  assert(snap.reentryMs.length === 0, "no reentry latency before history");
  noteChatWsReuseDiagResumeFail("resume_timeout");
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.resumeFail === 1, "timeout is a resume failure");
  assert(snap.failReasons.resume_timeout === 1, "timeout reason recorded");
  assert(snap.resumeOk === 0, "timeout is not success");
  noteChatWsReuseDiagParkSkip("socket_not_open");
  assert(getChatWsReuseDiagSnapshot().parkSkip === 1, "park skip distinct from resume fail");

  section("TTL expiry");
  noteChatWsReuseDiagTtlExpired();
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.ttlExpired === 1, "TTL counter increments");
  assert(snap.failReasons.park_expired === 1, "TTL reason recorded");

  section("percentiles");
  assert(percentileMs([], 50) === null, "empty p50 is null");
  assert(percentileMs([10, 20, 30, 40, 50], 50) === 30, "nearest-rank p50");
  assert(percentileMs([10, 20, 30, 40, 50], 95) === 50, "nearest-rank p95");
  assert(diagLatencyStat([]).sufficient === false, "empty latency is insufficient");
  assert(diagLatencyStat([1, 2, 3, 4]).sufficient === false, "n=4 is reference-only");
  assert(
    diagLatencyStat([1, 2, 3, 4, 5]).sufficient === true,
    `n=${CHAT_WS_REUSE_DIAG_MIN_COMPARE_SAMPLES} is enough to compare`
  );
  assert(diagLatencyStat([10, 20, 30, 40, 50]).p50 === 30, "stat p50");
  assert(diagLatencyStat([10, 20, 30, 40, 50]).p95 === 50, "stat p95");
  assert(diagLatencyStat([10, 20, 30, 40, 50]).n === 5, "stat n");

  section("SPA navigation keeps memory");
  resetChatWsReuseDiag();
  noteChatWsReuseDiagNewRoomSocket();
  noteChatWsReuseDiagParkAttempt();
  const beforeNav = getChatWsReuseDiagSnapshot();
  const afterNav = getChatWsReuseDiagSnapshot();
  assert(afterNav.newWs === beforeNav.newWs, "module snapshot survives SPA-style reread");
  assert(afterNav.parkAttempts === beforeNav.parkAttempts, "park count survives reread");
  assert(afterNav.running === true, "running flag survives reread");

  section("tab storage aggregates without PII");
  const stored = storage.getItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY);
  assert(typeof stored === "string" && stored.length > 0, "aggregates persist to sessionStorage");
  for (const key of CHAT_WS_REUSE_DIAG_FORBIDDEN_KEYS) {
    assert(!stored!.includes(`"${key}"`), `persisted JSON has no ${key} key`);
  }
  assert(!stored!.includes("Bearer"), "no token material");
  const saved = stored!;
  resetChatWsReuseDiagForTests();
  assert(getChatWsReuseDiagSnapshot().newWs === 0, "test reset clears memory");
  storage.setItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY, saved);
  hydrateChatWsReuseDiagFromStorageForTests();
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.newWs === 1, "reload hydrates new WS count");
  assert(snap.parkAttempts === 1, "reload hydrates park count");
  assert(snap.running === true, "reload hydrates running flag");

  section("logout / session reset wipes");
  handleChatWsReuseDiagSessionReset();
  snap = getChatWsReuseDiagSnapshot();
  assert(snap.running === false, "logout stops recording");
  assert(snap.newWs === 0, "logout clears new WS");
  assert(snap.resumeOk === 0, "logout clears resume ok");
  assert(snap.resumeMs.length === 0 && snap.newWsMs.length === 0 && snap.reentryMs.length === 0, "logout clears latency samples");
  assert(storage.getItem(CHAT_WS_REUSE_DIAG_STORAGE_KEY) == null, "logout removes tab storage");

  section("ChatClient observe-only wiring");
  assert(client.includes("isChatWsReuseDiagRecording()"), "ChatClient gates on recording");
  assert(client.includes("noteChatWsReuseDiagNewRoomSocket()"), "room WS is counted");
  assert(
    (client.match(/noteChatWsReuseDiagNewRoomSocket\(\)/g) || []).length === 1,
    "room WS note is a single call"
  );
  const dirAt = client.indexOf("const connectDirectory");
  const roomAt = client.indexOf("const connectSocket");
  assert(dirAt > 0 && roomAt > dirAt, "directory connect is separate from room connect");
  assert(
    !client.slice(dirAt, roomAt).includes("noteChatWsReuseDiagNewRoomSocket"),
    "directory WS is not counted"
  );
  assert(client.includes("noteChatWsReuseDiagParkAttempt()"), "park attempts are observed");
  assert(client.includes("noteChatWsReuseDiagParkOk()"), "park success is observed");
  assert(client.includes("noteChatWsReuseDiagResumeAttempt()"), "resume attempts are observed");
  const resumeOkAt = client.indexOf("noteChatWsReuseDiagResumeOk()");
  const resumeSendAt = client.indexOf('JSON.stringify({ type: "resume" })');
  const resumedOkAt = client.indexOf("if (resumed?.ok)");
  assert(resumeOkAt > resumedOkAt && resumedOkAt > 0, "resume success is after resumed?.ok");
  assert(resumeSendAt > 0 && resumeOkAt !== resumeSendAt, "sending resume is not the success hook");
  assert(client.includes("parkedResumeHistory"), "history success path is distinct from new WS");
  assert(client.includes("!parkedResumeHistory"), "new WS history is not counted on resume history");
  assert(client.includes("handleChatWsReuseDiagSessionReset()"), "ChatClient logout wipes diag");
  assert(client.includes("markChatWsReuseDiagLeftRoom()"), "leave marks reentry");
  assert(client.includes("markChatWsReuseDiagRoomSelect()"), "openRoom stamps reentry start");
  assert(client.includes("noteChatWsReuseDiagTtlExpired()"), "TTL expiry is observed");
  assert(client.includes("classifyParkedResumeSkip"), "resume skip uses existing classifier");
  const eligibleAt = client.indexOf("const eligible = () =>");
  const eligible = client.slice(eligibleAt, eligibleAt + 450);
  assert(eligible.includes("shouldParkChatWsReuse"), "diag does not replace resume eligibility");
  assert(eligible.includes("canResumeParked"), "diag does not replace canResumeParked");
  assert(client.includes("await refreshWsReuseRuntime()"), "park still re-checks runtime first");
  assert(!client.includes("chatPerfDiag"), "preview chatPerf is not reused");

  section("admin UI");
  const ui = read("src/app/manage/chat-ws-reuse-diag/ChatWsReuseDiagClient.tsx");
  for (const label of [
    "측정 시작",
    "측정 종료",
    "기록 초기화",
    "신규 WebSocket",
    "park 시도",
    "resume 시도",
    "resume 성공",
    "resume 실패",
    "재사용 성공률",
    "resume 재입장",
    "신규 연결 재입장",
    "전체 재입장",
    "{label} p50",
    "{label} p95",
    "n={stat.n}",
    "20초 TTL 만료",
    "history가 정상 수신된 횟수",
    "최초 방 입장 소켓은 분모에 넣지 않습니다",
    "개선이 확정된 수치는 아닙니다",
    "표본 부족",
  ]) {
    assert(ui.includes(label), `UI shows ${label}`);
  }
  assert(ui.includes("min-height: 44px"), "mobile tap targets");
  assert(ui.includes('href="/chat"'), "UI links to chat");
  assert(ui.includes("startChatWsReuseDiag({ adminAllowed })"), "UI start is admin-gated");
  assert(!ui.includes("fetch("), "UI does not call a diagnostic API");

  section("security / no prod side effects");
  const diagLib = read("src/lib/chatWsReuseDiag.ts");
  assert(!/prisma/i.test(diagLib), "diag lib has no Prisma");
  assert(!/DATABASE_URL|neon/i.test(diagLib), "diag lib has no DB URL");
  assert(!diagLib.includes("gtag") && !diagLib.includes("analytics"), "no analytics");
  assert(!fs.existsSync(path.resolve("src/app/api/chat/ws-reuse-diag")), "no new public diag API");
  assert(PRODUCTION_CHAT_WS_REUSE_ENABLED === true, "reuse compile flag unchanged");
  const reuseLib = read("src/lib/chatWsReuse.ts");
  assert(reuseLib.includes("PRODUCTION_CHAT_WS_REUSE_ENABLED: boolean = true"), "reuse helper still ON");
  assert(!client.includes("PRODUCTION_CHAT_WS_REUSE_ENABLED"), "ChatClient still does not flip the const");

  if (failed > 0) {
    console.error(`\nchat-ws-reuse-diag tests failed: ${failed} (passed ${passed})`);
    process.exit(1);
  }
  console.log(`\nchat-ws-reuse-diag tests passed: ${passed}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
