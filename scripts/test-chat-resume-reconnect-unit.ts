/**
 * 앱 복귀 재연결 중복 억제 + Directory open 직후 중복 sync 제거 — no DB, no network.
 * 1) 순수 판정 shouldSkipResumeReconnect 의 fail-open 경계
 * 2) ChatClient 배선 정적 검사(보안 경로 유지 포함)
 * 3) 결정적 모델 하네스: 가상 시계로 복귀 이벤트 시나리오별 "WS 생성(=Worker 인증) 횟수"와 "첫 이벤트→OPEN" 시간
 *    (모델이며 실기기·지역 지연 측정이 아님. 핸드셰이크 지연 H 는 입력 파라미터.)
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { CHAT_RESUME_COALESCE_MS, shouldSkipResumeReconnect, type ChatResumeStamp } from "../src/lib/chatResumeReconnect";

let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); } }

// ---------- 1) 순수 판정 ----------
const A = { id: "dirA" }, R = { id: "roomA" }, R2 = { id: "roomB" };
const stamp: ChatResumeStamp<object> = { at: 1000, token: "t1", roomId: "all", dirWs: A, roomWs: R };
const cur = { nowMs: 1015, token: "t1", roomId: "all" as string | null, dirWs: A as object | null, dirState: 0, roomWs: R as object | null, roomState: 0 };
assert(shouldSkipResumeReconnect(stamp, cur), "15ms 뒤 같은 토큰·방·소켓 CONNECTING → 건너뜀(중복)");
assert(shouldSkipResumeReconnect(stamp, { ...cur, dirState: 1, roomState: 1 }), "OPEN 이어도 window 이내 같은 소켓 → 건너뜀");
assert(!shouldSkipResumeReconnect(null, cur), "직전 기록 없음 → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, nowMs: 1000 + CHAT_RESUME_COALESCE_MS + 1 }), "window 초과 → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, nowMs: 999 }), "시계 역행(음수 경과) → 재연결(fail-open)");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, token: "t2" }), "토큰 교체(재발급·계정 전환) → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, token: null }), "토큰 없음 → 건너뛰지 않음");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, roomId: "dm:1:2" }), "다른 방 → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, roomId: null, roomWs: null, roomState: null }), "방→목록 상태 변경 → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, roomWs: R2 }), "방 소켓이 다른 객체(새 진입/재연결) → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, dirWs: null, dirState: null }), "세션 리셋으로 dirRef=null → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, roomWs: null, roomState: null }), "세션 리셋으로 wsRef=null → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, roomState: 3 }), "방 소켓 CLOSED(실패·서버 종료 4008/4003) → 재연결");
assert(!shouldSkipResumeReconnect(stamp, { ...cur, dirState: 2 }), "Directory CLOSING → 재연결");
const listStamp: ChatResumeStamp<object> = { at: 1000, token: "t1", roomId: null, dirWs: A, roomWs: null };
assert(shouldSkipResumeReconnect(listStamp, { ...cur, roomId: null, roomWs: null, roomState: null }), "목록 화면 중복 복귀 → 건너뜀");
assert(!shouldSkipResumeReconnect({ ...listStamp, dirWs: null }, { ...cur, roomId: null, dirWs: null }), "기록된 소켓 null 끼리 일치는 건너뛰지 않음");
assert(!shouldSkipResumeReconnect({ ...stamp, at: NaN }, cur), "NaN 시각 → 재연결");

// ---------- 2) 배선 정적 검사 ----------
const src = readFileSync(new URL("../src/app/chat/ChatClient.tsx", import.meta.url), "utf8");
const recon = src.slice(src.indexOf("const reconnect = () => {"), src.indexOf('window.addEventListener("online", reconnect)'));
assert(recon.includes("isChatSessionEnded()") && recon.indexOf("isChatSessionEnded()") < recon.indexOf("shouldSkipResumeReconnect"), "로그아웃/세션 종료 확인이 판정보다 먼저");
assert(recon.includes("tokenRef.current") && recon.includes("shouldSkipResumeReconnect(resumeStampRef.current"), "reconnect 가 현재 토큰과 직전 기록으로 판정");
assert(recon.includes("connectDirectory(info)") && recon.includes("void connectSocket(info, room.roomId)"), "건너뛰지 않으면 기존과 같은 재연결(Directory + 방)");
assert(recon.indexOf("resumeStampRef.current = {") > recon.indexOf("connectDirectory(info)"), "기록은 실제 재연결 뒤에만");
assert(/useRef<ChatResumeStamp<WebSocket> \| null>\(null\)/.test(src), "기록은 컴포넌트 ref(모듈 전역 없음 → 사용자/탭 간 공유 없음)");
const lib = readFileSync(new URL("../src/lib/chatResumeReconnect.ts", import.meta.url), "utf8");
assert(!/^\s*(let|var)\s/m.test(lib) && !/localStorage|sessionStorage|console\./.test(lib), "판정 모듈: 모듈 가변 상태·저장소·로그 없음");
const dirOpen = src.slice(src.indexOf("chatPerf.listConnectStart();"), src.indexOf('ws.addEventListener("error", () => {\n        if (gen !== dirGenRef.current) return;\n        setDirectoryConnected(false);'));
assert(!dirOpen.includes('JSON.stringify({ type: "sync" })'), "Directory open 직후 중복 sync 전송 제거");
assert(dirOpen.includes("setDirectoryConnected(true)") && dirOpen.includes("dirAttemptRef.current = 0"), "Directory open 처리(연결 표시·재시도 카운터)는 유지");
// 보안 경로 유지(이번 변경이 건드리지 않음)
assert(src.includes("subscribeChatSessionReset((reason) => {") && src.includes("resetChatSocketHandles({"), "세션 리셋 → 소켓 정리 경로 유지");
assert(src.includes("shouldRefreshTokenOnClose(ev.code)"), "4008 토큰 만료 → 재발급 경로 유지");
assert((src.match(/shouldConnectWithChatToken\(info, tokenRef\)/g) || []).length >= 2, "stale 토큰 연결 차단 유지(Directory·방)");
assert(src.includes('type: "resume"') && src.includes("parkedResumeClientGate"), "Preview 재사용은 WS resume 후 인증·history(fail-closed)");

// ---------- 3) 결정적 모델 하네스 ----------
// 모델: reconnect 호출마다 기존 소켓(OPEN/CONNECTING)을 닫고 새 소켓을 만든다(ChatClient connectDirectory/connectSocket 과 같은 의미).
// 새 소켓은 생성 후 H ms 뒤 OPEN(Worker 인증 1회 포함). 닫힌 소켓의 진행분은 버려진다.
type FakeWs = { id: number; createdAt: number; readyState: number; openAt: number };
function simulate(opts: { coalesce: boolean; H: number; events: { t: number; kind: string; failFirst?: boolean; tokenAt?: string }[]; inRoom: boolean }) {
  let seq = 0; const created: FakeWs[] = [];
  let dir: FakeWs | null = null, room: FakeWs | null = null;
  let token = "t1"; let stampRef: ChatResumeStamp<FakeWs> | null = null;
  const mk = (t: number): FakeWs => { const w = { id: ++seq, createdAt: t, readyState: 0, openAt: t + opts.H }; created.push(w); return w; };
  const advance = (t: number) => { for (const w of created) if (w.readyState === 0 && w.openAt <= t) w.readyState = 1; };
  const firstT = opts.events[0]!.t;
  for (const ev of opts.events) {
    advance(ev.t);
    if (ev.tokenAt) token = ev.tokenAt;
    if (ev.failFirst) { if (room) room.readyState = 3; if (dir) dir.readyState = 3; continue; }
    const curRoomId = opts.inRoom ? "all" : null;
    if (opts.coalesce && shouldSkipResumeReconnect(stampRef, { nowMs: ev.t, token, roomId: curRoomId, dirWs: dir, dirState: dir?.readyState, roomWs: opts.inRoom ? room : null, roomState: opts.inRoom ? room?.readyState : null })) continue;
    if (dir && dir.readyState <= 1) dir.readyState = 3; dir = mk(ev.t);
    if (opts.inRoom) { if (room && room.readyState <= 1) room.readyState = 3; room = mk(ev.t); }
    stampRef = { at: ev.t, token, roomId: curRoomId, dirWs: dir, roomWs: opts.inRoom ? room : null };
  }
  advance(Number.MAX_SAFE_INTEGER);
  const finalRoom = opts.inRoom ? room! : dir!;
  return { wsCreated: created.length, authRequests: created.length, firstEventToOpenMs: finalRoom.openAt - firstT };
}
const H_VALUES = [765, 1421, 2607]; // 과거 실측 "진입 전체" 범위를 핸드셰이크 지연 입력으로만 사용(현재 실측 아님)
const scenarios: { name: string; inRoom: boolean; events: { t: number; kind: string; failFirst?: boolean; tokenAt?: string }[]; expectSkip: boolean }[] = [
  { name: "S1 앱 복귀(방): visibility t0 + appState t+15", inRoom: true, events: [{ t: 0, kind: "visibility" }, { t: 15, kind: "appState" }], expectSkip: true },
  { name: "S2 앱 복귀(방): visibility + appState + online t+300", inRoom: true, events: [{ t: 0, kind: "visibility" }, { t: 15, kind: "appState" }, { t: 300, kind: "online" }], expectSkip: true },
  { name: "S3 앱 복귀(목록): visibility + appState", inRoom: false, events: [{ t: 0, kind: "visibility" }, { t: 20, kind: "appState" }], expectSkip: true },
  { name: "S4 브라우저 복귀 1회(visibility만)", inRoom: true, events: [{ t: 0, kind: "visibility" }], expectSkip: false },
  { name: "S5 5초 간격 두 번 복귀(window 밖)", inRoom: true, events: [{ t: 0, kind: "visibility" }, { t: 5000, kind: "visibility" }], expectSkip: false },
  { name: "S6 첫 연결 실패(CLOSED) 후 online", inRoom: true, events: [{ t: 0, kind: "visibility" }, { t: 100, kind: "fail", failFirst: true }, { t: 300, kind: "online" }], expectSkip: false },
  { name: "S7 토큰 교체 후 복귀 이벤트", inRoom: true, events: [{ t: 0, kind: "visibility" }, { t: 15, kind: "appState", tokenAt: "t2" }], expectSkip: false },
];
const raw: unknown[] = [];
console.log("\n[모델 하네스] 시나리오 | H | before(WS생성/첫이벤트→OPEN) | after");
for (const sc of scenarios) {
  for (const H of H_VALUES) {
    const before = simulate({ coalesce: false, H, events: sc.events, inRoom: sc.inRoom });
    const after = simulate({ coalesce: true, H, events: sc.events, inRoom: sc.inRoom });
    raw.push({ scenario: sc.name, H, before, after });
    console.log(`  ${sc.name} | H=${H} | ${before.wsCreated}/${before.firstEventToOpenMs}ms | ${after.wsCreated}/${after.firstEventToOpenMs}ms`);
    if (sc.expectSkip) {
      assert(after.wsCreated < before.wsCreated && after.firstEventToOpenMs <= before.firstEventToOpenMs, `${sc.name} H=${H}: 중복 제거(WS ${before.wsCreated}→${after.wsCreated})`);
    } else {
      assert(after.wsCreated === before.wsCreated && after.firstEventToOpenMs === before.firstEventToOpenMs, `${sc.name} H=${H}: 기존 동작과 동일(재연결 유지)`);
    }
  }
}
try {
  const out = process.env.CHAT_PERF_ARTIFACT_DIR;
  if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/resume-reconnect-model.json`, JSON.stringify(raw, null, 2)); }
} catch { /* artifact optional */ }

console.log(`\nresume-reconnect: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
