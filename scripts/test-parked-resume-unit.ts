/**
 * Parked WS resume (auth-then-history) — no DB, no network.
 * Verdict + client gate + ChatClient/Worker wiring.
 */
import { readFileSync } from "node:fs";
import { parkedResumeVerdict } from "../cloudflare/verthill-chat/src/parkedResume";
import {
  CHAT_WS_RESUME_TIMEOUT_MS,
  classifyParkedResumeWaitResult,
  isResumeSkipCode,
  parkedResumeClientGate,
} from "../src/lib/chatWsReuse";

let passed = 0, failed = 0;
function assert(c: unknown, m: string) {
  if (c) { passed++; console.log("  ✓", m); }
  else { failed++; console.error("  ✗", m); }
}

assert(CHAT_WS_RESUME_TIMEOUT_MS === 4000, "resume wait 4s");
assert(parkedResumeClientGate("history") === "history", "history 통과");
assert(parkedResumeClientGate("error") === "fail", "error 실패");
assert(parkedResumeClientGate("message") === "hold", "live message 보류");
assert(parkedResumeClientGate("sync") === "hold", "sync 보류");
assert(parkedResumeClientGate("perf") === "other", "perf 통과");
assert(classifyParkedResumeWaitResult({ gotHistory: true, gotError: false, closed: false, timedOut: false }) === "ok", "history → ok");
assert(classifyParkedResumeWaitResult({ gotHistory: false, gotError: true, closed: true, timedOut: false }) === "resume_auth", "닫힘 → resume_auth");
assert(classifyParkedResumeWaitResult({ gotHistory: false, gotError: false, closed: false, timedOut: true }) === "resume_timeout", "시간 초과 → resume_timeout");
assert(isResumeSkipCode("resume_auth") && isResumeSkipCode("resume_timeout"), "skip 코드 허용");

assert(parkedResumeVerdict({ session: { ok: true }, access: { ok: true } }).action === "allow", "둘 다 통과 → allow");
assert(
  parkedResumeVerdict({
    session: { ok: false, status: 401, error: "stale_session" },
    access: { ok: true },
  }).action === "deny",
  "세션 폐기 → deny"
);
assert(
  (parkedResumeVerdict({
    session: { ok: false, status: 503, error: "session_check_unavailable" },
    access: { ok: true },
  }) as { close?: string }).close === "unavailable",
  "세션 확인 장애 → unavailable"
);
assert(
  (parkedResumeVerdict({
    session: { ok: true },
    access: { ok: false, code: "room_forbidden" },
  }) as { close?: string }).close === "room_forbidden",
  "멤버십 없음 → room_forbidden"
);

const cc = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
const resumeBlock = cc.slice(cc.indexOf("const eligible = () =>"), cc.indexOf("const prev = wsRef.current;"));
assert(/type: "resume"/.test(cc), "재개 시 {type:resume} 전송");
assert(!/chatDirectoryRoomUrl\(roomId, info\.token\)/.test(resumeBlock), "재개 경로에서 Directory HTTP 재확인 제거");
assert(!/isResumeRevalidationOk/.test(resumeBlock), "재개 경로 HTTP 본문 판정 제거");
assert(/await resume\(\)/.test(resumeBlock), "재개는 history 수신까지 대기");
assert(/CHAT_WS_RESUME_TIMEOUT_MS/.test(cc), "재개 대기 시간 상한");
assert(/parkedResumeClientGate/.test(cc), "인증 전 메시지 게이트");
assert(/resumeOwnedCloseRef/.test(cc), "재개 실패 close 는 재연결하지 않음");
assert(/code === "superseded"/.test(resumeBlock), "재개 중 나가기 → superseded");
assert(/resume_timeout/.test(resumeBlock) && /resume_auth/.test(resumeBlock), "실패 코드 구분");
assert(/if \(gate === "hold"\) \{\s*return;/.test(cc), "게이트: message/sync 화면 미반영");
assert(/if \(gate === "fail"\)/.test(cc), "게이트: error 시 재사용 실패");

const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
assert(/private async handleParkedResume/.test(worker), "ChatRoom handleParkedResume");
const resumeFn = worker.slice(worker.indexOf("private async handleParkedResume"), worker.indexOf("private expireUnavailable"));
assert(/assertChatSessionCurrent\(this\.env, attach\.claims\)/.test(resumeFn), "resume 은 fail-closed session-check");
assert(!/probeChatSession/.test(resumeFn), "resume 에 fail-open probe 사용 안 함");
assert(/resolveChatRoomAccess/.test(resumeFn), "resume 멤버십 재검증");
assert(/parkedResumeVerdict/.test(resumeFn), "판정 헬퍼 사용");
assert(resumeFn.indexOf("assertChatSessionCurrent") < resumeFn.indexOf("sendHistory"), "인증 후에만 history");
assert(resumeFn.indexOf("parkedResumeVerdict") < resumeFn.indexOf("sendHistory"), "판정 후에만 history");
assert(/expireUnavailable/.test(resumeFn) && /expire\(ws, verdict\.close\)/.test(resumeFn), "실패 시 소켓 폐기");
assert(/this\.resumeInflight\.add\(ws\)/.test(worker), "resume 진행 중 history 직행 금지");
assert(/if \(this\.resumeInflight\.has\(ws\)\)/.test(worker), "inflight history 는 인증 뒤로");

const phoneRtt = 240;
const phoneSc = 250;
const before = 2 * phoneRtt + phoneSc;
const after = phoneRtt + phoneSc;
assert(after < before, `왕복 모델: HTTP+history ${before}ms → resume ${after}ms (RTT ${phoneRtt})`);
console.log(`  모델(휴대폰 RTT ${phoneRtt}·sc ${phoneSc}): 재진입 ${before}ms → ${after}ms, 절감 ${before - after}ms`);

console.log(`\nparked-resume-unit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
