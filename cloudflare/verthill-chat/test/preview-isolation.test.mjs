/**
 * Preview / Production 채팅 Worker 격리 (로컬 wrangler dev 전용, Cloudflare 인증·원격 없음).
 * - production 설정(최상위) Worker 와 `--env preview` Worker 를 각각 다른 비밀값·저장 경로로 띄운다.
 * - 교차 토큰 거부(같은 비밀값이어도 aud 로 거부), 저장소 분리를 확인한다.
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { TEST_SECRET, signTestTokenV2 } from "./token-helper.mjs";
import { HOST, startWrangler, stopWrangler } from "./wrangler-harness.mjs";

const PREVIEW_SECRET = "preview-local-test-only";

function open(port, token, room = "all") {
  return new Promise((resolve) => {
    const ws = new WebSocket(`ws://${HOST}:${port}/ws?room=${encodeURIComponent(room)}&token=${encodeURIComponent(token)}`);
    const timer = setTimeout(() => { try { ws.close(); } catch {} resolve({ ok: false, why: "timeout" }); }, 8000);
    ws.addEventListener("message", (ev) => {
      const d = JSON.parse(String(ev.data));
      if (d.type === "history") { clearTimeout(timer); resolve({ ok: true, ws, history: d.messages || [] }); }
    });
    ws.addEventListener("error", () => { clearTimeout(timer); resolve({ ok: false, why: "error" }); });
  });
}

async function httpStatus(port, token) {
  const res = await fetch(`http://${HOST}:${port}/directory/rooms?token=${encodeURIComponent(token)}`);
  await res.text();
  return res.status;
}

function waitFor(ws, pred, ms = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), ms);
    ws.addEventListener("message", (ev) => { const d = JSON.parse(String(ev.data)); if (pred(d)) { clearTimeout(t); resolve(d); } });
  });
}

test("preview / production chat worker isolation", async (t) => {
  const prodDir = mkdtempSync(join(tmpdir(), "vh-chat-prod-"));
  const prevDir = mkdtempSync(join(tmpdir(), "vh-chat-prev-"));
  const prod = await startWrangler({ persistTo: prodDir });
  const prev = await startWrangler({ persistTo: prevDir, secret: PREVIEW_SECRET, extraArgs: ["--env", "preview"] });
  t.after(async () => { await stopWrangler(prod.child); await stopWrangler(prev.child); rmSync(prodDir, { recursive: true, force: true }); rmSync(prevDir, { recursive: true, force: true }); });

  const prodTok = signTestTokenV2({ userId: 21 }, TEST_SECRET).token;
  const prevTok = signTestTokenV2({ userId: 21, aud: "preview" }, PREVIEW_SECRET).token;
  const prevTokWithProdSecret = signTestTokenV2({ userId: 21, aud: "preview" }, TEST_SECRET).token;
  const prodTokWithPrevSecret = signTestTokenV2({ userId: 21 }, PREVIEW_SECRET).token;

  await t.test("production worker: 기존 토큰(aud 없음) 허용 — 호환성", async () => {
    assert.equal(await httpStatus(prod.port, prodTok), 200);
    const r = await open(prod.port, prodTok); assert.equal(r.ok, true); r.ws.close();
  });
  await t.test("production worker: preview 토큰 거부 (다른 비밀값)", async () => {
    assert.equal(await httpStatus(prod.port, prevTok), 401);
    assert.equal((await open(prod.port, prevTok)).ok, false);
  });
  await t.test("production worker: preview aud 토큰은 같은 비밀값이어도 거부", async () => {
    assert.equal(await httpStatus(prod.port, prevTokWithProdSecret), 401);
  });
  await t.test("preview worker: preview 토큰 허용", async () => {
    assert.equal(await httpStatus(prev.port, prevTok), 200);
    const r = await open(prev.port, prevTok); assert.equal(r.ok, true); r.ws.close();
  });
  await t.test("preview worker: production 토큰 거부 (다른 비밀값)", async () => {
    assert.equal(await httpStatus(prev.port, prodTok), 401);
    assert.equal((await open(prev.port, prodTok)).ok, false);
  });
  await t.test("preview worker: aud 없는 토큰은 preview 비밀값으로 서명돼도 거부", async () => {
    assert.equal(await httpStatus(prev.port, prodTokWithPrevSecret), 401);
  });
  await t.test("저장소 분리: preview 에 보낸 메시지는 production 에 없음", async () => {
    const a = await open(prev.port, prevTok);
    assert.equal(a.ok, true);
    a.ws.send(JSON.stringify({ type: "message", clientMessageId: "c-iso-1", body: "preview only", mentions: [], mentionAll: false }));
    const echo = await waitFor(a.ws, (d) => d.type === "message" && d.clientMessageId === "c-iso-1");
    assert.equal(echo.body, "preview only");
    a.ws.close();
    const b = await open(prod.port, prodTok);
    assert.equal(b.ok, true);
    assert.equal(b.history.some((m) => m.body === "preview only"), false);
    b.ws.close();
    const c = await open(prev.port, prevTok);
    assert.equal(c.history.some((m) => m.body === "preview only"), true);
    c.ws.close();
  });
});
