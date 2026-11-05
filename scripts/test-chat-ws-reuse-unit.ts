/** Preview 전용 방 WebSocket 재사용(파킹) — no DB, no network. 순수 판정 + ChatClient 배선 정적 검사. */
import { readFileSync } from "node:fs";
import { canResumeParked, resolveChatWsReuse, CHAT_WS_REUSE_TTL_MS, CHAT_WS_REUSE_HISTORY_BEFORE } from "../src/lib/chatWsReuse";
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
const req = { roomId: "A", token: "t1", nowSec: now, socketOpen: true };
assert(canResumeParked(p, req), "같은 방·같은 토큰·OPEN → 재개");
assert(!canResumeParked(p, { ...req, roomId: "B" }), "다른 방 → 재개 금지(섞임 방지)");
assert(!canResumeParked(p, { ...req, token: "t2" }), "토큰 교체(재발급·재로그인) → 새 연결");
assert(!canResumeParked(p, { ...req, socketOpen: false }), "서버가 닫음/폐기(4008 등) → 새 연결");
assert(!canResumeParked({ ...p, exp: now + 10 }, req), "토큰 만료 임박 → 새 연결");
assert(!canResumeParked(null, req), "파킹 없음 → 새 연결");
assert(!canResumeParked({ ...p, roomId: "" }, { ...req, roomId: "" }), "빈 방 ID → 금지");

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
assert(/if \(wsReuseEnabledRef\.current\) \{\s*\/\/[^\n]*\n\s*socketResumeRef\.current\.set/.test(src), "재사용 꺼짐이면 재개 함수 미등록(기존 동작)");
assert(!/type: "read"[^\n]*parked/.test(src), "파킹 경로에서 읽음 전송 없음");

console.log(`\nchat-ws-reuse-unit: ${passed} passed, ${failed} failed`);
if (failed) process.exit(1);
