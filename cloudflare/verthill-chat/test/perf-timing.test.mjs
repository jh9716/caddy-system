// 로컬 통합 테스트(wrangler dev --local, 합성 값): Preview Worker 에서만 perf 프레임이 history 뒤에 오고,
// session-check 지연(mock 300ms 주입)이 sc 값에 반영되며, 운영 모드에서는 perf 프레임이 없다.
import assert from "node:assert/strict";
import test from "node:test";
import WebSocket from "ws";
import { signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

function open(port, token) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws?room=all&token=${encodeURIComponent(token)}`,
      { headers: { "x-chat-ws-perf": "sc=1;tok=1", "x-chat-ws-colo": "ZZZ" } }); // 위조 헤더 → Worker 가 제거/덮어써야 함
    const msgs = [];
    const raw = [];
    ws.raw = raw;
    ws.on("message", (d) => { const t = String(d); raw.push(t); try { msgs.push(JSON.parse(t)); } catch { /* non-JSON */ } });
    ws.once("open", () => resolve({ ws, msgs }));
    ws.once("unexpected-response", (_q, r) => reject(new Error("http " + r.statusCode)));
    ws.once("error", reject);
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

test("preview: perf 프레임(숫자만) history 뒤, session-check 지연 반영", async () => {
  const { port, child, mock } = await startWrangler({ extraArgs: ["--var", "CHAT_TOKEN_AUDIENCE:preview"] });
  try {
    mock.setDelay(300);
    const tok = signTestTokenV2({ userId: 51, displayName: "x", team: "A", sv: 0, aud: "preview" }).token;
    const { ws, msgs } = await open(port, tok);
    await wait(500);
    ws.close();
    const hi = msgs.findIndex((m) => m.type === "history");
    const pi = msgs.findIndex((m) => m.type === "perf");
    assert.ok(hi >= 0 && pi > hi, "perf 는 history 뒤");
    const t = msgs[pi].t;
    assert.ok(Object.values(t).every((v) => Number.isInteger(v) && v >= 0), "숫자만");
    assert.ok(t.sc >= 280, `sc 가 mock 지연 반영 (sc=${t.sc})`);
    assert.ok(t.edge >= t.sc, "edge >= sc");
    assert.ok(!JSON.stringify(msgs[pi]).match(/userId|room|token|http/), "식별자 없음");
    assert.equal(t.doFirst, 1, "새 DO 인스턴스 첫 fetch → doFirst=1");
    assert.ok([0, 1, 2, 3].includes(t.doAge), "doAge 구간");
    const colo = msgs[pi].colo;
    assert.ok(colo === undefined || /^[A-Z]{3}$/.test(colo), "colo 는 없거나 대문자 3글자");
    assert.notEqual(colo, "ZZZ", "클라이언트가 보낸 colo 헤더는 사용하지 않음");
    // 두 번째 연결: 같은 인스턴스 → doFirst=0
    const second = await open(port, tok);
    await wait(400);
    const p2 = second.msgs.find((m) => m.type === "perf");
    assert.equal(p2.t.doFirst, 0, "같은 인스턴스 두 번째 fetch → doFirst=0");
    // 자동응답 핑: 정확한 문자열에만 pong, 채팅 메시지/오류 프레임 없음
    const before = second.msgs.length;
    second.ws.send("vh-perf-ping");
    await wait(300);
    assert.ok(second.ws.raw.includes("vh-perf-pong"), "Preview: vh-perf-ping → vh-perf-pong");
    assert.equal(second.msgs.length, before, "핑은 JSON 프레임(오류/메시지)을 만들지 않음");
    second.ws.send(JSON.stringify({ type: "sync", afterSeq: 0, limit: 5 }));
    await wait(300);
    assert.ok(second.msgs.length > before, "핑 이후에도 기존 프로토콜 정상");
    second.ws.close();
  } finally {
    await stopWrangler(child);
  }
});

test("production(audience 미설정): perf 프레임 없음", async () => {
  const { port, child } = await startWrangler();
  try {
    const tok = signTestTokenV2({ userId: 52, displayName: "x", team: "A", sv: 0 }).token;
    const { ws, msgs } = await open(port, tok);
    await wait(400);
    assert.ok(msgs.some((m) => m.type === "history"));
    assert.ok(!msgs.some((m) => m.type === "perf"));
    assert.ok(!msgs.some((m) => "colo" in m || "doFirst" in m), "운영: colo/추가 perf 필드 없음");
    ws.raw.length = 0;
    const ws2 = await open(port, tok);
    ws2.ws.send("vh-perf-ping");
    await wait(300);
    assert.ok(!ws2.ws.raw.includes("vh-perf-pong"), "운영: 자동응답 없음");
    ws2.ws.close();
    ws.close();
  } finally {
    await stopWrangler(child);
  }
});
