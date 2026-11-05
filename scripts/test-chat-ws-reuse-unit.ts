/** Preview 전용 방 WebSocket 재사용(파킹) — no DB, no network. 순수 판정 + ChatClient 배선 정적 검사. */
import { readFileSync } from "node:fs";
import { canResumeParked, isParkExpired, isResumeRevalidationOk, resolveChatWsReuse, CHAT_WS_REUSE_TTL_MS, CHAT_WS_REUSE_HISTORY_BEFORE } from "../src/lib/chatWsReuse";
import { buildRecord } from "../src/lib/chatPerfDiag";
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
assert(/let gen = roomGenRef\.current;/.test(src) && /gen = roomGenRef\.current;\s*stopPerfPing\(\);\s*historyResetRef\.current = true;/.test(src), "재개 시 새 세대 + history 리셋 경로");
assert(/type: "history", beforeSeq: CHAT_WS_REUSE_HISTORY_BEFORE/.test(src), "재개 시 서버 history 재요청(서버 readAttach 권한·만료·폐기 재검사)");
assert(/if \(wsReuseEnabledRef\.current\) \{\s*socketStopPingRef\.current\.set\(ws, stopPerfPing\);\s*\/\/[^\n]*\n\s*socketResumeRef\.current\.set/.test(src), "재사용 꺼짐이면 재개 함수 미등록(기존 동작)");
assert(!/type: "read"[^\n]*parked/.test(src), "파킹 경로에서 읽음 전송 없음");

assert(/parkedAt: Date\.now\(\)/.test(src), "파킹 시작 시각 기록");
assert(/addEventListener\("visibilitychange"/.test(src) && /addEventListener\("pageshow", check\)/.test(src) && /isParkExpired\(parked\.parkedAt, Date\.now\(\)\)\) dropParkedRoomSocket\(\)/.test(src), "복귀(visibility/pageshow) 시 TTL 초과면 즉시 폐기");
assert(/socketStopPingRef\.current\.get\(ws\)\?\.\(\);[\s\S]{0,200}parkedRoomRef\.current = \{ \.\.\.meta, ws, timer, parkedAt/.test(src), "파킹 시 진단 핑 타이머 정리");
const resumeBlock = src.slice(src.indexOf("const eligible = () =>"), src.indexOf("const prev = wsRef.current;"));
assert(/chatDirectoryRoomUrl\(roomId, info\.token\)/.test(resumeBlock) && /isResumeRevalidationOk\(res\.status, body, roomId\)/.test(resumeBlock), "재개 전 Worker 방 조회로 권한 재확인");
assert(resumeBlock.indexOf("isResumeRevalidationOk") < resumeBlock.indexOf("resume!()"), "재확인 통과 후에만 재개");
assert(/if \(revalidated && eligible\(\)\)/.test(resumeBlock), "재확인 후 TTL·소켓 상태 재검사");
assert(/if \(roomGenRef\.current !== genBefore\) return \{ ok: false, code: "superseded" \}/.test(resumeBlock), "확인 중 나가기/방 이동 → 이 진입 폐기(섞임 방지)");
assert(/catch \{\s*revalidated = false;/.test(resumeBlock), "재확인 오류 → 재사용 금지");
assert(/try \{\s*parked\.ws\.close\(\);/.test(resumeBlock), "재사용 실패 → 파킹 소켓 닫고 기존 새 연결로");

console.log(`\nchat-ws-reuse-unit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
