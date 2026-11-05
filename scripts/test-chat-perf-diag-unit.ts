/** Preview 전용 chatPerf 진단 — no DB, no network. */
import { buildRecord, chatPerfText, classifyEntry, diffMs, isChatPerfAllowed, sanitizeServerPerf, serverPerfLine } from "../src/lib/chatPerfDiag";
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
const allowed = ["n", "kind", "tokenMs", "tokenFetched", "tapToOpenMs", "openToHistoryMs", "historyToRenderMs", "tapToVisibleMs", "ok"];
assert(Object.keys(r).every((k) => allowed.includes(k)) && Object.keys(r).length === allowed.length, "레코드 필드는 ms/라벨만 (PII 필드 없음)");
assert(Object.values(r).every((v) => typeof v === "number" || typeof v === "boolean" || v === null || ["first","switch","reentry","deeplink"].includes(v as string)), "레코드 값은 숫자/불리언/일반 라벨만");
const t = chatPerfText({ entries: [r], list: [{ n: 1, tokenMs: 50, connectToListMs: 200 }], server: [] });
assert(!/token=|room|user|http|\?/i.test(t), "복사 텍스트에 URL/ID/쿼리 없음");
const sp = sanitizeServerPerf({ tok: 1, sc: 1200, scApp: 900, scDb: 40, scCold: 1, mem: 30, edge: 1260, doAccept: 2, userId: 7, room: "x", token: "abc", bad: -1, frac: 1.5 });
assert(Object.keys(sp).join(",") === "tok,sc,scApp,scDb,scCold,mem,edge,doAccept", "서버 perf: 허용 키·정수만 (ID/토큰/음수/소수 제거)");
assert(Object.keys(sanitizeServerPerf(null)).length === 0 && Object.keys(sanitizeServerPerf("x")).length === 0, "서버 perf: 잘못된 입력 → 빈 값");
const sl = serverPerfLine({ n: 1, t: sp });
assert(sl.includes("session-check왕복 1200") && !/http|\?|token=|user/i.test(sl), "서버 perf 줄: 숫자만, URL/ID 없음");
console.log(`\n${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
