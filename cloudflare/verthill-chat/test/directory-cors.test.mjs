/**
 * Directory HTTP CORS (Preview 재사용 재확인용 GET /directory/rooms/{id} 등).
 * Local wrangler only. 인증·멤버십 검사 결과는 그대로, 응답에 CORS 헤더만 있어야 한다. WS 101 은 그대로.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const ORIGIN = "https://preview-app.example";
function hasCors(res) {
  return res.headers.get("access-control-allow-origin") === "*";
}

test("directory HTTP responses carry CORS; auth/membership unchanged; WS upgrade intact", async () => {
  // 다른 테스트(perf-timing 의 새 DO 판정)에 상태가 남지 않도록 전용 저장 경로 사용
  const persistTo = mkdtempSync(join(tmpdir(), "vh-dir-cors-"));
  const { port, child, mock } = await startWrangler({ persistTo });
  try {
    const base = `http://${HOST}:${port}`;
    const a = signTestTokenV2({ userId: 31, displayName: "코르A", role: "caddy" });
    const q = (t) => `?token=${encodeURIComponent(t)}`;

    const summary = await fetch(`${base}/directory/rooms/all${q(a.token)}`, { headers: { origin: ORIGIN } });
    const body = await summary.json();
    assert.equal(summary.status, 200);
    assert.equal(body.room.roomId, "all");
    assert.ok(hasCors(summary), "room summary 200 has CORS");

    const list = await fetch(`${base}/directory/rooms${q(a.token)}`, { headers: { origin: ORIGIN } });
    assert.equal(list.status, 200);
    assert.ok(hasCors(list), "room list 200 has CORS");

    const members = await fetch(`${base}/directory/rooms/all/members${q(a.token)}`, { headers: { origin: ORIGIN } });
    assert.equal(members.status, 200);
    assert.ok(hasCors(members), "members 200 has CORS");

    // 멤버 아님 → 403 그대로(fail-closed), 헤더만 추가
    const forbidden = await fetch(`${base}/directory/rooms/c_${"0".repeat(8)}nope${q(a.token)}`, { headers: { origin: ORIGIN } });
    assert.ok(forbidden.status === 403 || forbidden.status === 400, `non-member denied (${forbidden.status})`);
    assert.ok(hasCors(forbidden), "denied response has CORS");

    // 토큰 없음/위조 → 401 (Worker 단계, 원래도 CORS 있음)
    const noTok = await fetch(`${base}/directory/rooms/all`, { headers: { origin: ORIGIN } });
    assert.equal(noTok.status, 401);
    assert.ok(hasCors(noTok));
    const badTok = await fetch(`${base}/directory/rooms/all?token=x.y`, { headers: { origin: ORIGIN } });
    assert.equal(badTok.status, 401);

    // 세션 폐기(DB sessionVersion 증가) → 200 아님
    mock.setEpoch(31, 5);
    const staleRes = await fetch(`${base}/directory/rooms/all${q(a.token)}`, { headers: { origin: ORIGIN } });
    assert.notEqual(staleRes.status, 200, "stale session denied");
    assert.ok(hasCors(staleRes));
    mock.setEpoch(31, 0);

    // 퇴사/채팅 차단 → session-check 거부 → 200 아님
    mock.setBlocked(31, true);
    const blockedRes = await fetch(`${base}/directory/rooms/all${q(a.token)}`, { headers: { origin: ORIGIN } });
    assert.notEqual(blockedRes.status, 200, "blocked user denied");
    assert.ok(hasCors(blockedRes));
    mock.setBlocked(31, false);
    // session-check 장애 → 503 (fail-closed)
    mock.setUnavailable(true);
    const down = await fetch(`${base}/directory/rooms/all${q(a.token)}`, { headers: { origin: ORIGIN } });
    assert.notEqual(down.status, 200, "auth store down denied");
    mock.setUnavailable(false);

    // 프리플라이트
    const pre = await fetch(`${base}/directory/rooms/all`, { method: "OPTIONS", headers: { origin: ORIGIN, "access-control-request-method": "GET" } });
    assert.equal(pre.status, 204);
    assert.ok(hasCors(pre));

    // WS 101 업그레이드 경로 그대로(forwardDirectory 를 지나는 /directory/ws). 방 /ws 는 이 변경과 무관(다른 테스트가 검증)
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://${HOST}:${port}/directory/ws${q(a.token)}`);
      const t = setTimeout(() => reject(new Error("dir ws timeout")), 8000);
      ws.addEventListener("message", () => { clearTimeout(t); ws.close(); resolve(); });
      ws.addEventListener("error", () => { clearTimeout(t); reject(new Error("dir ws error")); });
    });
  } finally {
    await stopWrangler(child);
    rmSync(persistTo, { recursive: true, force: true });
  }
});
