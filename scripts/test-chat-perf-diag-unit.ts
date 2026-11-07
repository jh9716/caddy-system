/** Preview 전용 chatPerf 진단 — no DB, no network. */
import { buildRecord, chatPerfText, classifyEntry, diffMs, isChatPerfAllowed, resolveServerEntry, sanitizeServerPerf, sanitizeReuseOutcome, serverPerfLine, reusePerfLine, safeColo, bindSocketAttempt, openTimings, addRttSample, rttStats, updateNet, netPerfLine, CHAT_PERF_PING, CHAT_PERF_PONG, type ChatPerfNetRecord } from "../src/lib/chatPerfDiag";
let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); } }

assert(!isChatPerfAllowed({ VERCEL_ENV: "preview" }, ""), "preview, 쿼리 없음 → 숨김");
assert(!isChatPerfAllowed({ VERCEL_ENV: "preview" }, "?chatPerf=0"), "chatPerf=0 → 숨김");
assert(!isChatPerfAllowed({ VERCEL_ENV: "production" }, "?chatPerf=1"), "production + 쿼리 → 숨김");
assert(!isChatPerfAllowed({ NEXT_PUBLIC_VERCEL_ENV: "production" }, "?chatPerf=1"), "NEXT_PUBLIC production + 쿼리 → 숨김");
assert(!isChatPerfAllowed({}, "?chatPerf=1"), "로컬(env 없음=운영 취급) + 쿼리 → 숨김");
assert(isChatPerfAllowed({ VERCEL_ENV: "preview" }, "?chatPerf=1"), "preview + 쿼리 → 표시");
assert(isChatPerfAllowed({ NEXT_PUBLIC_CHAT_APP_ENV: "preview" }, "?x=1&chatPerf=1"), "빌드 마커 preview + 쿼리 → 표시");

assert(diffMs(100, 350.4) === 250, "diffMs 반올림");
assert(diffMs(null, 5) === null && diffMs(10, 5) === null, "diffMs 누락/역순 → null");
assert(classifyEntry({ hasPrevious: false, sameAsPrevious: false, deepLink: false }) === "first", "첫 진입");
assert(classifyEntry({ hasPrevious: true, sameAsPrevious: false, deepLink: false }) === "switch", "방 전환");
assert(classifyEntry({ hasPrevious: true, sameAsPrevious: true, deepLink: false }) === "reentry", "재진입");
assert(classifyEntry({ hasPrevious: true, sameAsPrevious: true, deepLink: true }) === "deeplink", "딥링크 우선");

const r = buildRecord(1, { kind: "switch", tap: 0, tokenStart: 0, tokenEnd: 40, tokenFetched: true, open: 300, history: 420, commit: 450 }, 470, true);
assert(r.tapToOpenMs === 300 && r.openToHistoryMs === 120 && r.historyToRenderMs === 30 && r.tapToVisibleMs === 470 && r.tokenMs === 40, "구간 계산");
const allowed = ["n", "kind", "tokenMs", "tokenFetched", "tapToOpenMs", "openToHistoryMs", "historyToRenderMs", "tapToVisibleMs", "reused", "ok"];
assert(Object.keys(r).every((k) => allowed.includes(k)) && Object.keys(r).length === allowed.length, "레코드 필드는 ms/라벨만 (PII 필드 없음)");
assert(Object.values(r).every((v) => typeof v === "number" || typeof v === "boolean" || v === null || ["first","switch","reentry","deeplink"].includes(v as string)), "레코드 값은 숫자/불리언/일반 라벨만");
const t = chatPerfText({ entries: [r], list: [{ n: 1, tokenMs: 50, connectToListMs: 200 }], server: [], net: [] });
assert(!/token=|room|user|http|\?/i.test(t), "복사 텍스트에 URL/ID/쿼리 없음");
const sp = sanitizeServerPerf({ tok: 1, sc: 1200, scApp: 900, scDb: 40, scCold: 1, mem: 30, edge: 1260, doAccept: 2, userId: 7, room: "x", token: "abc", bad: -1, frac: 1.5 });
assert(Object.keys(sp).join(",") === "tok,sc,scApp,scDb,scCold,mem,edge,doAccept", "서버 perf: 허용 키·정수만 (ID/토큰/음수/소수 제거)");
assert(Object.keys(sanitizeServerPerf(null)).length === 0 && Object.keys(sanitizeServerPerf("x")).length === 0, "서버 perf: 잘못된 입력 → 빈 값");
const sl = serverPerfLine({ n: 1, attempt: 1, entry: 2, t: sp });
assert(sl.includes("session-check왕복 1200") && !/http|\?|token=|user/i.test(sl), "서버 perf 줄: 숫자만, URL/ID 없음");
{
  const done = new Map([[1, 7]]);
  const seen = new Set<number>();
  assert(resolveServerEntry(1, 2, done, seen).accept && resolveServerEntry(1, 2, done, seen).entry === 7, "늦게 온 프레임 → 자기 시도(완료된 진입#7)에만 연결");
  assert(resolveServerEntry(2, 2, done, seen).accept && resolveServerEntry(2, 2, done, seen).entry === null, "진행 중 같은 시도 → 대기(null), 완료 시 채움");
  assert(!resolveServerEntry(3, 2, done, seen).accept, "다른(모르는) 시도 프레임 → 버림 (빠른 방 전환 시 섞임 없음)");
  assert(!resolveServerEntry(null, 2, done, seen).accept, "시도 번호 없는 소켓(재연결 등) → 버림");
  assert(!resolveServerEntry(1, 2, done, new Set([1])).accept, "같은 시도 중복 프레임 → 버림");
  assert(!resolveServerEntry(1.5 as unknown as number, 2, done, seen).accept, "비정수 시도 → 버림");
}
{
  const bound = new Set<number>();
  assert(bindSocketAttempt(1, bound) === 1, "진입#1 첫 소켓 → 번호 부여");
  assert(bindSocketAttempt(1, bound) === null, "같은 진입의 재연결 소켓 → null (값 섞임 없음)");
  assert(bindSocketAttempt(2, bound) === 2, "방 전환(새 진입) → 새 번호");
  assert(bindSocketAttempt(null, bound) === null, "진입 없이 재연결 → null");
  // colo 검증
  assert(safeColo("LAX") === "LAX" && safeColo("NRT") === "NRT", "colo: 대문자 3글자 허용");
  assert([ "lax", "LAXX", "LA", "1AX", "", null, undefined, 3, "1.2.3.4" ].every((v) => safeColo(v) === null), "colo: 그 외 전부 거부");
  // open 시각
  const o = openTimings(100, 400, 450);
  assert(o.ctorToOpenMs === 300 && o.evToHandlerMs === 50, "생성→open / 이벤트→핸들러 분리");
  assert(openTimings(100, -5, 450).ctorToOpenMs === null && openTimings(100, -5, 450).evToHandlerMs === null, "음수 timeStamp → null");
  assert(openTimings(100, 1.7e12, 450).ctorToOpenMs === null, "epoch 기준 timeStamp(구형 브라우저) → null");
  assert(openTimings(100, 50, 450).ctorToOpenMs === null, "생성자 이전 timeStamp → null");
  assert(openTimings(100, "x", 450).evToHandlerMs === null, "비숫자 → null");
  // RTT
  let r: number[] = [];
  for (const v of [40, 10.4, -1, 70000, 30, 99]) r = addRttSample(r, v);
  assert(r.join(",") === "40,10,30", "RTT: 정수 0~60000, 최대 3개");
  const st = rttStats([40, 10, 30]);
  assert(st.min === 10 && st.median === 30, "RTT min/중앙값");
  assert(rttStats([]).min === null, "RTT 없음 → null");
  // 방 전환·늦은 pong/프레임: attempt 일치 기록에만
  const mk = (n: number, attempt: number): ChatPerfNetRecord => ({ n, attempt, entry: null, tapToCtorMs: 1, ctorToOpenMs: null, evToHandlerMs: null, colo: null, doFirst: null, rtt: [] });
  let recs = [mk(2, 2), mk(1, 1)];
  recs = updateNet(recs, 1, (x) => ({ ...x, rtt: addRttSample(x.rtt, 55) })); // 방 전환 후 늦게 온 attempt1 의 pong
  assert(recs[0]!.rtt.length === 0 && recs[1]!.rtt[0] === 55, "늦은 pong 은 자기 시도에만 (현재 방 기록에 섞이지 않음)");
  const same = updateNet(recs, 9, (x) => ({ ...x, colo: "ZZZ" }));
  assert(same.every((x) => x.colo === null), "모르는 시도 → 변경 없음");
  assert(updateNet(recs, null, (x) => ({ ...x, colo: "ZZZ" })).every((x) => x.colo === null), "재연결 소켓(attempt null) → 변경 없음");
  // 텍스트: 숫자·colo·플래그만
  const line = netPerfLine({ ...mk(1, 1), colo: "LAX", doFirst: 1, rtt: [40, 10, 30], ctorToOpenMs: 900, evToHandlerMs: 12 });
  assert(line.includes("colo LAX") && line.includes("RTT min 10 / 중앙값 30") && line.includes("휴대폰↔WS 응답경로") && !/Worker→DO|http|token|user|room|\?/i.test(line), "네트워크 줄: 숫자·colo·플래그만, Worker→DO 로 표기하지 않음");
  assert(CHAT_PERF_PING === "vh-perf-ping" && CHAT_PERF_PONG === "vh-perf-pong", "핑 문자열(Worker 와 동일)");
  const full = chatPerfText({ entries: [], list: [], server: [], net: [{ ...mk(1, 1), colo: "NRT", doFirst: 0, rtt: [20] }] });
  assert(!/[a-z0-9]{20,}|\?|=|http/i.test(full.replace(/\(n=\d\)/g, "")), "복사 텍스트: 토큰/URL/쿼리 형태 없음");
}
{
  const ok = sanitizeReuseOutcome({ code: "ok", revalidateMs: 240.4, http: 200 });
  assert(ok && ok.code === "ok" && ok.revalidateMs === 240 && ok.http === 200, "재사용 성공 계측 정제");
  assert(sanitizeReuseOutcome({ code: "revalidate_net", revalidateMs: -1, http: 99 })?.http === null, "비정상 상태코드 버림");
  assert(sanitizeReuseOutcome({ code: "token=abc" }) === null, "비허용 코드 버림");
  const rl = reusePerfLine({ n: 2, code: "revalidate_net", revalidateMs: 512, http: null });
  assert(rl.includes("건너뜀") && rl.includes("revalidate_net") && !/http:|\?|token=/i.test(rl), "재사용 줄: URL/토큰 없음");
  const withReuse = chatPerfText({ entries: [], list: [], server: [], net: [], reuse: [{ n: 1, code: "ok", revalidateMs: 200, http: 200 }] });
  assert(withReuse.includes("재사용#1") && !/http:|\?|=/i.test(withReuse), "복사 텍스트에 재사용 줄, URL 없음");
}
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
