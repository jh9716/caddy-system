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
      { headers: { "x-chat-ws-perf": "sc=1;tok=1" } }); // 위조 헤더 → Worker 가 덮어써야 함
    const msgs = [];
    ws.on("message", (d) => msgs.push(JSON.parse(String(d))));
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
    ws.close();
    assert.ok(msgs.some((m) => m.type === "history"));
    assert.ok(!msgs.some((m) => m.type === "perf"));
  } finally {
    await stopWrangler(child);
  }
});
