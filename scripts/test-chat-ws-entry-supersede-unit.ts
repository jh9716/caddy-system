/**
 * 방 진입 대체(superseded) 처리 회귀 — no DB, no network(모든 fetch 는 가짜).
 * 1) chatWsOpenFailureCode: 대체된 소켓은 진단 HTTP 프로브(= Worker 전체 인증 1회)를 보내지 않음. 대체되지 않은 실패는 기존 진단 그대로(4003/4008/401 등).
 * 2) chatPerf 기록 귀속: 이전 진입의 늦은 실패가 새 진입을 "(실패)"로 덮는 문제 재현(구 호출) → 수정 확인(시도 번호 지정).
 * 3) ChatClient 배선 정적 검사 + 보안 경로 유지.
 * 4) 결정적 모델: 빠른 재진입 k회 시 추가 진단 프로브 수 before/after.
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";

let passed = 0, failed = 0;
function assert(c: unknown, m: string) { if (c) { passed++; console.log("  ✓", m); } else { failed++; console.error("  ✗", m); } }

async function main() {
  const dm = await import("../src/lib/chatDmClient");
  const WS = "wss://chat.example.test/ws?room=all&token=TEST";
  const mkFetch = (status: number, body: unknown) => {
    const calls: string[] = [];
    const f = (async (u: string) => { calls.push(String(u)); return new Response(JSON.stringify(body), { status }); }) as unknown as typeof fetch;
    return { f, calls };
  };
  const throwing = { calls: 0, f: (async () => { throwing.calls++; throw new Error("net"); }) as unknown as typeof fetch };

  // ---------- 1) 실패 코드 ----------
  {
    const a = mkFetch(401, { error: "stale_session" });
    assert((await dm.chatWsOpenFailureCode(true, WS, 1006, a.f)) === "superseded" && a.calls.length === 0, "대체된 소켓: superseded, 프로브 0회");
    assert((await dm.chatWsOpenFailureCode(false, WS, 1006, a.f)) === "stale_session" && a.calls.length === 1, "대체 안 됨 + 401 stale_session: 기존 진단 결과 그대로(프로브 1회)");
    const b = mkFetch(403, { error: "room_forbidden" });
    assert((await dm.chatWsOpenFailureCode(false, WS, 1006, b.f)) === (await dm.diagnoseChatWsFailure(WS, 1006, b.f)), "room_forbidden(퇴출·권한) 코드 기존과 동일");
    for (const code of [4003, 4008, 1006, undefined]) {
      const x = await dm.chatWsOpenFailureCode(false, WS, code, throwing.f);
      const y = await dm.diagnoseChatWsFailure(WS, code, throwing.f);
      assert(x === y, `프로브 실패 시 close 코드 판정 기존과 동일 (close=${code} → ${x})`);
    }
    assert((await dm.chatWsOpenFailureCode(false, WS, 4008, throwing.f)) === "stale_session", "4008 → stale_session 유지(토큰 재발급 경로)");
  }

  // ---------- 2) chatPerf 귀속 ----------
  const g = globalThis as any;
  g.window = { location: { search: "?chatPerf=1" } };
  g.requestAnimationFrame = (cb: () => void) => { cb(); return 0; };
  process.env.NEXT_PUBLIC_CHAT_APP_ENV = "preview";
  const perfMod = await import("../src/lib/chatPerfDiag");
  const { chatPerf, initChatPerf, getChatPerfState, isPendingAttempt } = perfMod;
  assert(initChatPerf() === true, "Preview + chatPerf=1 에서만 계측 활성(테스트 환경)");
  assert(isPendingAttempt({ attempt: 2 }, 2) && !isPendingAttempt({ attempt: 2 }, 1) && isPendingAttempt({ attempt: 2 }, null) && !isPendingAttempt(null, 2), "isPendingAttempt 경계");

  const raw: Record<string, unknown> = {};
  // 재현(구 호출 방식 = 시도 번호 없음): A 진입 중 B 재진입 → A 의 늦은 실패가 B 를 덮음
  chatPerf.clear();
  chatPerf.roomTap("reentry");
  chatPerf.roomTap("reentry");
  chatPerf.roomFailed(); // A 의 늦은 실패(구 호출)
  chatPerf.roomOpen(); chatPerf.roomHistory();
  const before = getChatPerfState().entries.map((e) => ({ ok: e.ok, tapToOpenMs: e.tapToOpenMs }));
  raw.legacyCall = before;
  assert(before.length === 1 && before[0]!.ok === false && before[0]!.tapToOpenMs === null, "재현: 구 호출은 성공한 새 진입 B 를 '(실패)'로 기록하고 B 의 실제 시간은 사라짐");

  // 수정: 시도 번호 지정
  chatPerf.clear();
  const a = chatPerf.roomTap("reentry");
  const b = chatPerf.roomTap("reentry");
  chatPerf.roomFailed(a);
  chatPerf.roomTokenReady(a); // A 의 늦은 토큰 완료도 B 에 섞이지 않음
  const midTok = getChatPerfState().entries.length;
  chatPerf.roomTokenReady(b);
  chatPerf.roomOpen(); chatPerf.roomHistory();
  const after = getChatPerfState().entries.map((e) => ({ ok: e.ok, tapToOpenMs: e.tapToOpenMs }));
  raw.scopedCall = after;
  assert(typeof a === "number" && typeof b === "number" && a !== b, "roomTap 이 진입별 시도 번호 반환");
  assert(midTok === 0, "이전 진입 A 의 실패는 기록되지 않음(새 진입 진행 중)");
  assert(after.length === 1 && after[0]!.ok === true && after[0]!.tapToOpenMs != null, "수정: 새 진입 B 는 성공으로 기록, 시간 보존");
  // 현재 진입 자신의 실제 실패는 여전히 기록
  chatPerf.clear();
  const c = chatPerf.roomTap("first");
  chatPerf.roomFailed(c);
  assert(getChatPerfState().entries.length === 1 && getChatPerfState().entries[0]!.ok === false, "현재 진입의 실제 실패는 그대로 '(실패)' 기록");

  // ---------- 3) 배선 정적 검사 ----------
  const cc = readFileSync("src/app/chat/ChatClient.tsx", "utf8");
  assert(/void chatWsOpenFailureCode\(gen !== roomGenRef\.current, url\)\.then/.test(cc), "waitForOpen onError: 대체 여부(gen) 전달");
  assert(/void chatWsOpenFailureCode\(gen !== roomGenRef\.current, url, ev\.code\)\.then/.test(cc), "waitForOpen onClose: 대체 여부 + close 코드 전달");
  assert(/perfEntry = chatPerf\.roomTap\(/.test(cc) && /chatPerf\.roomTokenReady\(perfEntry\)/.test(cc) && (cc.match(/chatPerf\.roomFailed\(perfEntry\)/g) || []).length === 2, "openRoom 계측은 자기 시도 번호로만 갱신");
  assert(!/chatPerf\.roomFailed\(\)/.test(cc), "시도 번호 없는 roomFailed 호출 없음");
  assert(/if \(!opened\.ok && opened\.code !== "superseded" && isDmRoomId\(room\.roomId\)\)/.test(cc), "DM: 대체된 진입은 오류 문구 없음");
  assert(/if \(!opened\.ok && opened\.code !== "superseded"\) \{\n\s+setError\(formatChatClientError\(CHAT_DM_OPEN_FAILED/.test(cc), "DM 시작: 대체만 제외, 실제 실패 오류 문구 유지");
  // 보안·세션 경로 유지(문자열 존재)
  assert(/if \(!shouldConnectWithChatToken\(info, tokenRef\)\) return \{ ok: false, code: "stale_session" \};/.test(cc), "connectSocket stale 토큰 차단 유지");
  assert(/if \(shouldRefreshTokenOnClose\(ev\.code\)\) \{/.test(cc), "close 코드(4008 등) 토큰 재발급 경로 유지");
  assert(/revalidated = isResumeRevalidationOk\(res\.status, body, roomId\);/.test(cc), "소켓 재사용 재확인(fail-closed) 유지");
  assert(/if \(roomGenRef\.current !== genBefore\) return \{ ok: false, code: "superseded" \};/.test(cc), "재사용 재확인 중 이동 → superseded 유지");
  assert(/applyAttachmentUpgradeToAttachments\(/.test(cc) && /type: "read", seq: last\.seq/.test(cc), "사진 업그레이드·읽음 전송 경로 존재(변경 없음)");

  // ---------- 4) 결정적 모델: 빠른 재진입 ----------
  // 모델: 진입 k 회를 연속으로 탭해 앞의 k-1 개 소켓이 CONNECTING 중 대체(close)됨. 대체 소켓마다 기존 코드는 진단 프로브 1회(= Worker 전체 인증·session-check 1회).
  const model: Record<string, { probesBefore: number; probesAfter: number }> = {};
  for (const k of [1, 2, 3, 5]) {
    let pb = 0, pa = 0;
    for (let i = 0; i < k - 1; i++) {
      const fb = mkFetch(426, { error: "upgrade_required" });
      await dm.diagnoseChatWsFailure(WS, 1006, fb.f); pb += fb.calls.length;
      const fa = mkFetch(426, { error: "upgrade_required" });
      await dm.chatWsOpenFailureCode(true, WS, 1006, fa.f); pa += fa.calls.length;
    }
    model[`taps${k}`] = { probesBefore: pb, probesAfter: pa };
  }
  raw.rapidReentryModel = { note: "결정적 모델(실기기 아님). 프로브 1회 = Worker /ws HTTP(전체 authorizeSocket, session-check 1회).", model };
  assert(model.taps3!.probesBefore === 2 && model.taps3!.probesAfter === 0, "모델: 3연속 탭 → 추가 인증 프로브 2 → 0");

  try {
    const out = process.env.CHAT_PERF_ARTIFACT_DIR;
    if (out) { mkdirSync(out, { recursive: true }); writeFileSync(`${out}/ws-entry-supersede-model.json`, JSON.stringify(raw, null, 2)); }
  } catch { /* optional */ }
  console.log(`\nws-entry-supersede: ${passed} passed, ${failed} failed`);
  if (failed) process.exit(1);
}
main().catch((e) => { console.error(e); process.exit(1); });
