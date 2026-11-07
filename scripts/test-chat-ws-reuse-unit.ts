/** Preview 전용 방 WebSocket 재사용(파킹) — no DB, no network. 순수 판정 + ChatClient 배선 정적 검사. */
import { readFileSync } from "node:fs";
import { canResumeParked, classifyParkedResumeSkip, classifyRevalidationSkip, isParkExpired, isResumeRevalidationOk, isResumeSkipCode, resolveChatWsReuse, CHAT_WS_REUSE_TTL_MS, CHAT_WS_REUSE_HISTORY_BEFORE } from "../src/lib/chatWsReuse";
import { buildRecord, reusePerfLine, sanitizeReuseOutcome } from "../src/lib/chatPerfDiag";
import { withBrowserCors } from "../cloudflare/verthill-chat/src/browserCors";
let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); } }

// 플래그: 운영 기본 꺼짐
assert(!resolveChatWsReuse({ VERCEL_ENV: "production" }, "?chatReuse=1", "1").enabled, "production → 항상 꺼짐");
assert(!resolveChatWsReuse({}, "?chatReuse=1", "1").enabled, "로컬(운영 취급) → 꺼짐");
assert(!resolveChatWsReuse({ NEXT_PUBLIC_VERCEL_ENV: "preview" }, "", null).enabled, "preview 기본 → 꺼짐");
const on = resolveChatWsReuse({ NEXT_PUBLIC_VERCEL_ENV: "preview" }, "?chatReuse=1", null);
assert(on.enabled && on.store === "1", "preview + chatReuse=1 → 켜짐·탭 저장");
assert(resolveChatWsReuse({ NEXT_PUBLIC_CHAT_APP_ENV: "preview" }, "", "1").enabled, "저장된 탭 → 켜짐");
const off = resolveChatWsReuse({ NEXT_PUBLIC_VERCEL_ENV: "preview" }, "?chatReuse=0", "1");
assert(!off.enabled && off.store === null, "chatReuse=0 → 끔·저장 삭제");
assert(CHAT_WS_REUSE_TTL_MS >= 20000 && CHAT_WS_REUSE_TTL_MS <= 30000, "TTL 20~30초");
assert(CHAT_WS_REUSE_HISTORY_BEFORE === Number.MAX_SAFE_INTEGER, "최신 history 요청 값");

// 재개 판정
const now = 1_000_000;
const p = { roomId: "A", token: "t1", exp: now + 600 };
const T0 = 5_000_000;
const req = { roomId: "A", token: "t1", nowSec: now, socketOpen: true, parkedAt: T0, nowMs: T0 + 1000 };
assert(canResumeParked(p, req), "같은 방·같은 토큰·OPEN → 재개");
assert(!canResumeParked(p, { ...req, roomId: "B" }), "다른 방 → 재개 금지(섞임 방지)");
assert(!canResumeParked(p, { ...req, token: "t2" }), "토큰 교체(재발급·재로그인) → 새 연결");
assert(!canResumeParked(p, { ...req, socketOpen: false }), "서버가 닫음/폐기(4008 등) → 새 연결");
assert(!canResumeParked({ ...p, exp: now + 10 }, req), "토큰 만료 임박 → 새 연결");
assert(!canResumeParked(null, req), "파킹 없음 → 새 연결");
assert(!canResumeParked({ ...p, roomId: "" }, { ...req, roomId: "" }), "빈 방 ID → 금지");

// TTL: 벽시계 경과 기준 (타이머 지연·백그라운드와 무관)
assert(!isParkExpired(T0, T0 + CHAT_WS_REUSE_TTL_MS), "경과 = TTL → 아직 유효");
assert(isParkExpired(T0, T0 + CHAT_WS_REUSE_TTL_MS + 1), "경과 > TTL → 만료");
assert(!canResumeParked(p, { ...req, nowMs: T0 + 45_000 }), "setTimeout 지연(타이머 미발화)이어도 45초 경과 → 재사용 금지");
assert(!canResumeParked(p, { ...req, nowMs: T0 + 5 * 60_000 }), "백그라운드 5분 후 복귀 → 재사용 금지");
assert(canResumeParked(p, { ...req, nowMs: T0 + 8_000 }), "백그라운드 8초 후 복귀(TTL 이내·OPEN) → 재사용 가능");
assert(!canResumeParked(p, { ...req, nowMs: T0 + 8_000, socketOpen: false }), "복귀했지만 OS 가 소켓을 끊음 → 새 연결");
assert(!canResumeParked(p, { ...req, parkedAt: undefined }), "파킹 시작 시각 없음 → 금지(fail-closed)");
assert(!canResumeParked(p, { ...req, nowMs: T0 - 1 }), "시계 역행 → 금지(fail-closed)");
assert(!canResumeParked(p, { roomId: "A", token: "t1", nowSec: now, socketOpen: true }), "nowMs 누락 → 금지");

// 재개 직전 권한 재확인 (Worker 방 조회 = 새 연결과 같은 검사) — fail-closed
const ok = { ok: true, room: { roomId: "A" } };
assert(isResumeRevalidationOk(200, ok, "A"), "200 + 같은 방 → 통과");
assert(!isResumeRevalidationOk(401, { error: "stale_session" }, "A"), "sessionVersion 변경(401) → 재사용 금지");
assert(!isResumeRevalidationOk(401, { error: "chat_blocked" }, "A"), "퇴사/채팅 차단(401) → 재사용 금지");
assert(!isResumeRevalidationOk(403, { error: "room_forbidden" }, "A"), "멤버 아님(403) → 재사용 금지");
assert(!isResumeRevalidationOk(404, null, "A"), "404 → 금지");
assert(!isResumeRevalidationOk(503, null, "A"), "세션 확인 장애(503) → 금지");
assert(!isResumeRevalidationOk(null, null, "A"), "네트워크 오류 → 금지");
assert(!isResumeRevalidationOk(200, { ok: true, room: { roomId: "B" } }, "A"), "다른 방 응답 → 금지");
assert(!isResumeRevalidationOk(200, { ok: true }, "A"), "형식 오류 → 금지");
assert(!isResumeRevalidationOk(200, ok, ""), "빈 방 → 금지");
assert(classifyRevalidationSkip(200, ok, "A") === null, "재확인 통과 → skip 없음");
assert(classifyRevalidationSkip(0, null, "A") === "revalidate_http", "CORS/opaque 상태 0 → revalidate_http");
assert(classifyRevalidationSkip(200, { ok: true }, "A") === "revalidate_body", "200 형식 오류 → revalidate_body");
assert(classifyRevalidationSkip(401, { error: "stale_session" }, "A") === "revalidate_http", "401 → revalidate_http");
assert(classifyParkedResumeSkip(p, { ...req, hasResume: false }) === "no_resume", "재개 함수 없음");
assert(classifyParkedResumeSkip(p, { ...req, wsRefMatch: false }) === "ws_ref", "소켓 참조 불일치");
assert(classifyParkedResumeSkip(p, req) === null, "자격 충족 → skip 없음");
assert(isResumeSkipCode("revalidate_net") && !isResumeSkipCode("token=abc") && !isResumeSkipCode("http://x"), "skip 코드 허용 목록");

// chatPerf 재사용 표시
const base = { kind: "reentry" as const, tap: 0, tokenStart: 0, tokenEnd: 0, tokenFetched: false, open: 1, history: 2, commit: 3 };
assert(buildRecord(1, { ...base, reused: true }, 4, true).reused === true, "chatPerf: 재사용 진입 표시");
assert(buildRecord(2, base, 4, true).reused === false, "chatPerf: 새 연결 표시");

// ChatClient 배선(정적)
const src = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
const leaves = src.match(/roomGenRef\.current \+= 1;\s*clearTimer\(roomTimerRef\);\s*if \(!parkRoomSocket\(\)\) wsRef\.current\?\.close\(\);/g) || [];
assert(leaves.length === 2, "뒤로가기·안드로이드 나가기: 세대 변경 후 파킹(아니면 기존 닫기)");
assert(/dropParkedRoomSocket\(\);\s*wsRef\.current\?\.close\(\);\s*dirRef\.current\?\.close\(\);/.test(src), "언마운트: 파킹 소켓 닫기");
assert(/subscribeChatSessionReset\(\(reason\) => \{\s*dropParkedRoomSocket\(\);/.test(src), "로그아웃/세션 리셋: 파킹 소켓 닫기");
assert(/if \(gen !== roomGenRef\.current\) return;\s*[\s\S]{0,400}type === "message"/.test(src) || (src.match(/gen !== roomGenRef\.current/g) || []).length >= 5, "파킹 중 이벤트는 세대 불일치로 무시(읽음 전송 없음)");
assert(/let gen = roomGenRef\.current;/.test(src) && /gen = roomGenRef\.current;\s*const myGen = gen;\s*stopPerfPing\(\);\s*historyResetRef\.current = true;/.test(src), "재개 시 새 세대 + history 리셋 경로");
assert(/type: "resume"/.test(src), "재개 시 서버 resume(session-check·멤버십 후 history)");
assert(/if \(wsReuseEnabledRef\.current\) \{\s*socketStopPingRef\.current\.set\(ws, stopPerfPing\);\s*\/\/[^\n]*\n\s*socketResumeRef\.current\.set/.test(src), "재사용 꺼짐이면 재개 함수 미등록(기존 동작)");
assert(!/type: "read"[^\n]*parked/.test(src), "파킹 경로에서 읽음 전송 없음");

assert(/parkedAt: Date\.now\(\)/.test(src), "파킹 시작 시각 기록");
assert(/addEventListener\("visibilitychange"/.test(src) && /addEventListener\("pageshow", check\)/.test(src) && /isParkExpired\(parked\.parkedAt, Date\.now\(\)\)\) dropParkedRoomSocket\(\)/.test(src), "복귀(visibility/pageshow) 시 TTL 초과면 즉시 폐기");
assert(/socketStopPingRef\.current\.get\(ws\)\?\.\(\);[\s\S]{0,200}parkedRoomRef\.current = \{ \.\.\.meta, ws, timer, parkedAt/.test(src), "파킹 시 진단 핑 타이머 정리");
const resumeBlock = src.slice(src.indexOf("const eligible = () =>"), src.indexOf("const prev = wsRef.current;"));
assert(/await resume\(\)/.test(resumeBlock), "재개는 서버 인증+history 완료까지 대기");
assert(!/isResumeRevalidationOk/.test(resumeBlock) && !/chatDirectoryRoomUrl\(roomId, info\.token\)/.test(resumeBlock), "재개 경로 Directory HTTP 제거");
assert(/code === "superseded"/.test(resumeBlock) && /reuseOutcome\("superseded"/.test(resumeBlock), "확인 중 나가기/방 이동 → 이 진입 폐기(섞임 방지)");
assert(/return \{ ok: false, code: "superseded" \}/.test(src), "superseded 반환 유지");
assert(/skipCode = "resume_auth"/.test(resumeBlock), "재개 인증 실패 → resume_auth");
assert(/try \{\s*parked\.ws\.close\(\);/.test(resumeBlock), "재사용 실패 → 파킹 소켓 닫고 기존 새 연결로");
assert(/chatPerf\.reuseOutcome\("ok"/.test(resumeBlock), "재사용 성공 계측");

// Worker: Directory HTTP 에 브라우저 CORS 부여 (Preview 앱 origin 에서 GET /directory/rooms/:id 읽기)
const worker = readFileSync("cloudflare/verthill-chat/src/index.ts", "utf8");
assert(worker.includes("withBrowserCors(res)"), "forwardDirectory 가 Directory HTTP 에 CORS 부여");
assert(worker.includes('from "./browserCors"'), "Worker CORS 헬퍼 사용");
const corsOk = new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } });
const corsed = withBrowserCors(corsOk);
assert(corsed.headers.get("access-control-allow-origin") === "*", "200 JSON → ACAO *");
assert(corsed.status === 200, "상태 유지");
{
  // 휴대폰 재현: Directory JSON 에 ACAO 없으면 브라우저가 본문을 못 읽어 재사용이 0회가 된다.
  const raw = new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } });
  let blocked = false;
  try {
    if (raw.headers.get("access-control-allow-origin") !== "*") throw new Error("Failed to fetch");
  } catch {
    blocked = true;
  }
  assert(blocked && !isResumeRevalidationOk(undefined, null, "A"), "CORS 차단 → 재확인 실패(재사용 0회)");
  const readable = withBrowserCors(new Response(JSON.stringify(ok), { status: 200, headers: { "content-type": "application/json" } }));
  assert(readable.headers.get("access-control-allow-origin") === "*" && isResumeRevalidationOk(readable.status, ok, "A"), "CORS 부여 후 200+같은 방 → 재사용 가능");
}
assert(/if \(res\.status === 101\) return res/.test(readFileSync("cloudflare/verthill-chat/src/browserCors.ts", "utf8")), "101 WebSocket 은 CORS 래핑 안 함");
const denied = sanitizeReuseOutcome({ code: "revalidate_net", revalidateMs: 512.2, http: 0, token: "secret" } as { code: string; revalidateMs: number; http: number });
assert(denied && denied.code === "revalidate_net" && denied.revalidateMs === 512 && denied.http === null, "계측: 코드·ms만, 잘못된 상태/토큰 버림");
assert(sanitizeReuseOutcome({ code: "http://evil", revalidateMs: 1 }) === null, "비허용 코드 버림");
const line = reusePerfLine({ n: 1, code: "revalidate_net", revalidateMs: 512, http: null });
assert(line.includes("revalidate_net") && line.includes("512") && !/http:|\?|token/i.test(line), "재사용 줄: 코드·숫자만");

console.log(`\nchat-ws-reuse-unit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
