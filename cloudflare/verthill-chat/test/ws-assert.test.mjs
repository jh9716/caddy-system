/**
 * Worker 진입부 → ChatRoom DO 확인서(session-check 중복 제거) 보안·정합성 회귀.
 * 로컬 wrangler + mock session-check 전용. Production/Preview Worker·DB 미사용.
 */
import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

function open(port, room, token, headers = {}) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(
      `ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`,
      { headers }
    );
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
    ws.once("open", () => resolve({ ws, msgs }));
    ws.once("unexpected-response", (_req, res) => reject(Object.assign(new Error("http"), { status: res.statusCode })));
    ws.once("error", (e) => reject(e));
  });
}

async function waitFor(msgs, pred, ms = 8000) {
  const t = Date.now();
  while (Date.now() - t < ms) {
    const hit = msgs.find(pred);
    if (hit) return hit;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("timeout");
}

async function status(port, room, token, headers = {}) {
  try {
    const c = await open(port, room, token, headers);
    c.ws.close();
    return 101;
  } catch (e) {
    return e.status || 0;
  }
}

test("ws assertion: 1 session-check per connect, forgery ignored, revoke/blocked/forbidden kept, order", async () => {
  const { port, child, mock } = await startWrangler();
  try {
    const a = signTestTokenV2({ userId: 31, displayName: "가", role: "caddy", sv: 1 });
    const b = signTestTokenV2({ userId: 32, displayName: "나", role: "caddy", sv: 1 });
    mock.setEpoch(31, 1);
    mock.setEpoch(32, 1);

    mock.resetCalls();
    const ca = await open(port, "all", a.token);
    await waitFor(ca.msgs, (d) => d.type === "history");
    assert.equal(mock.sessionCheckCalls(), 1, "connect 당 session-check 1회(이전 2회)");

    // 위조: 클라이언트가 확인서 헤더를 직접 보냄 → Worker 가 지우고 다시 씀. 신원은 토큰 기준.
    const forgedClaims = Buffer.from(JSON.stringify({ v: 2, userId: 999, displayName: "관리자", role: "admin", sv: 0, iat: 1, exp: 9999999999 })).toString("base64url");
    const forged = {
      "x-chat-ws-claims": forgedClaims,
      "x-chat-ws-assert-ts": String(Math.floor(Date.now() / 1000)),
      "x-chat-ws-assert": "AAAA",
    };
    const cb = await open(port, "all", b.token, forged);
    await waitFor(cb.msgs, (d) => d.type === "history");
    const id = `f-${Date.now()}`;
    cb.ws.send(JSON.stringify({ type: "message", clientMessageId: id, body: "forged?" }));
    const got = await waitFor(ca.msgs, (d) => d.type === "message" && d.clientMessageId === id);
    assert.equal(got.senderUserId, 32, "위조 claims 무시, 토큰 사용자 유지");
    assert.equal(await status(port, "all", "bad.token", forged), 401, "토큰 없이 위조 헤더만으로 통과 불가");

    // 순서·중복
    const ids = [];
    for (let i = 0; i < 8; i++) {
      const mid = `o-${i}-${Date.now()}`;
      ids.push(mid);
      ca.ws.send(JSON.stringify({ type: "message", clientMessageId: mid, body: `n${i}` }));
    }
    await waitFor(cb.msgs, (d) => d.clientMessageId === ids[7]);
    const seen = cb.msgs.filter((d) => d.type === "message" && ids.includes(d.clientMessageId)).map((d) => d.clientMessageId);
    assert.deepEqual(seen, ids, "순서 유지·중복 없음");
    const seqs = cb.msgs.filter((d) => d.type === "message" && ids.includes(d.clientMessageId)).map((d) => d.seq);
    assert.ok(seqs.every((s, i) => i === 0 || s > seqs[i - 1]), "seq 증가");

    // 세션 폐기/만료/권한
    mock.setEpoch(31, 2);
    assert.equal(await status(port, "all", a.token), 401, "로그아웃(sv 증가) 후 재접속 거부");
    mock.setBlocked(32, true);
    assert.equal(await status(port, "all", b.token), 401, "차단 사용자 거부");
    const c = signTestTokenV2({ userId: 33, displayName: "다", role: "caddy", team: "1조", sv: 1 });
    mock.setEpoch(33, 1);
    assert.equal(await status(port, "team-2", c.token), 403, "다른 조 방 거부");
    const now = Math.floor(Date.now() / 1000);
    const exp = signTestTokenV2({ userId: 34, displayName: "라", role: "caddy", sv: 1, iat: now - 100, exp: now - 1 });
    assert.equal(await status(port, "all", exp.token), 401, "만료 토큰 거부");
    ca.ws.close();
    cb.ws.close();
  } finally {
    await stopWrangler(child);
  }
});
